import type { ChatCompletionRequest, ProviderResult } from "./providers/base";
import { providers, getAllModels, type ProviderName } from "./providers/registry";
import { isNonAccountRequestError, isTransientError, extractHttpStatus } from "./errors";
import { applyPudidilFilters } from "./filters";
import { pool } from "./pool";
import type { Account } from "../db/schema";
import {
  compressRequest,
  getCompressionConfig,
  type CompressionStats,
} from "./compression";

export interface RouteResult {
  result: ProviderResult;
  account: Account;
  provider: ProviderName;
  durationMs: number;
  compressionStats?: CompressionStats;
}

/**
 * Raised when every candidate account failed. Carries the upstream detail the
 * API layer needs to build an honest error response instead of a generic 503:
 * the raw upstream message, its HTTP status (when the upstream sent one), the
 * provider's own rate-limit/quota flags (providers often return a bare upstream
 * body with no status to parse), and which account/attempt produced it.
 */
export class AllAccountsFailedError extends Error {
  readonly provider: ProviderName;
  readonly upstreamError: string;
  readonly upstreamStatus: number | null;
  readonly rateLimited: boolean;
  readonly quotaExhausted: boolean;
  readonly attempts: number;
  readonly lastAccountId?: number;
  readonly lastAccountEmail?: string;

  constructor(init: {
    provider: ProviderName;
    upstreamError: string;
    attempts: number;
    rateLimited?: boolean;
    quotaExhausted?: boolean;
    lastAccountId?: number;
    lastAccountEmail?: string;
  }) {
    const upstreamStatus = extractHttpStatus(init.upstreamError);
    const where = init.lastAccountEmail
      ? ` (last account: ${init.lastAccountEmail})`
      : "";
    const attemptLabel = init.attempts === 1 ? "attempt" : "attempts";
    super(
      `All accounts failed for ${init.provider} after ${init.attempts} ${attemptLabel}${where}. ` +
        `Upstream error: ${init.upstreamError || "unknown error"}`
    );
    this.name = "AllAccountsFailedError";
    this.provider = init.provider;
    this.upstreamError = init.upstreamError;
    this.upstreamStatus = upstreamStatus;
    this.rateLimited = init.rateLimited ?? false;
    this.quotaExhausted = init.quotaExhausted ?? false;
    this.attempts = init.attempts;
    this.lastAccountId = init.lastAccountId;
    this.lastAccountEmail = init.lastAccountEmail;
  }
}

/** Check if a request contains image content blocks */
function requestHasImages(request: ChatCompletionRequest): boolean {
  return request.messages.some((msg) => {
    if (!Array.isArray(msg.content)) return false;
    return (msg.content as any[]).some(
      (block) => block?.type === "image_url" || block?.type === "image"
    );
  });
}

/**
 * Sanitize request by applying pudidil filters to all text content.
 * Strips Claude Code identity, billing headers, and other patterns
 * that trigger content moderation on upstream providers.
 */
function sanitizeRequest(request: ChatCompletionRequest): ChatCompletionRequest {
  const sanitized = { ...request };

  sanitized.messages = request.messages.map((msg) => {
    if (typeof msg.content === "string") {
      return { ...msg, content: applyPudidilFilters(msg.content) };
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: (msg.content as any[]).map((block) => {
          if (block?.type === "text" && typeof block.text === "string") {
            return { ...block, text: applyPudidilFilters(block.text) };
          }
          if (block?.type === "tool_result") {
            if (typeof block.content === "string") {
              return { ...block, content: applyPudidilFilters(block.content) };
            }
            if (Array.isArray(block.content)) {
              return {
                ...block,
                content: block.content.map((inner: any) =>
                  inner?.type === "text" && typeof inner.text === "string"
                    ? { ...inner, text: applyPudidilFilters(inner.text) }
                    : inner
                ),
              };
            }
          }
          return block;
        }),
      };
    }
    return msg;
  });

  if (sanitized.tools) {
    sanitized.tools = request.tools!.map((tool: any) => {
      if (tool?.function?.description) {
        return {
          ...tool,
          function: {
            ...tool.function,
            description: applyPudidilFilters(tool.function.description),
          },
        };
      }
      return tool;
    });
  }

  return sanitized;
}

/**
 * Route a chat completion request to the appropriate provider/account.
 * Implements retry logic with fallback to next account.
 */
export async function routeRequest(
  request: ChatCompletionRequest,
  stream: boolean
): Promise<RouteResult> {
  // Apply content filters to strip Claude Code identity, billing headers, etc.
  const sanitizedRequest = sanitizeRequest(request);

  const hasImages = requestHasImages(sanitizedRequest);
  const providerName = pool.getProviderForModel(sanitizedRequest.model);
  if (!providerName) {
    throw new Error(`No provider found for model: ${sanitizedRequest.model}`);
  }

  // Apply compression pipeline (RTK + DCP + Caveman + image dedupe + cache markers).
  // Failures here are non-fatal — fall back to the sanitized request and move on.
  let compressedRequest = sanitizedRequest;
  let compressionStats: CompressionStats | undefined;
  try {
    const cfg = await getCompressionConfig();
    const out = compressRequest(sanitizedRequest, cfg, providerName);
    compressedRequest = out.request;
    compressionStats = out.stats;
  } catch (err) {
    console.error("[Compression] Failed, passing request through unchanged:", err);
  }

  const provider = providers[providerName];
  if (!provider) {
    throw new Error(`Provider not configured: ${providerName}`);
  }

  // Reject image requests for models that don't support vision
  if (hasImages) {
    const modelInfo = provider.getModelInfo(sanitizedRequest.model);
    if (modelInfo && !modelInfo.vision) {
      throw new Error(
        `Model "${sanitizedRequest.model}" does not support image/vision inputs. Use a vision-capable model instead.`
      );
    }
  }

  // Try up to 3 accounts before giving up
  const maxRetries = 3;
  let lastError = "";
  let lastAccountId: number | undefined;
  let lastAccountEmail: string | undefined;
  let attemptsMade = 0;
  // Whether the final failure was a rate limit / quota exhaustion. Providers
  // signal these with flags rather than a parseable status, so record them for
  // the API layer's status mapping.
  let lastRateLimited = false;
  let lastQuotaExhausted = false;
  const attemptedByokAccountIds = new Set<number>();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // BYOK uses prefix-based account lookup (not the generic pool),
    // so it can also find error-status accounts and retry them.
    let account = providerName === "byok"
      ? (await pool.getAccountForModel(compressedRequest.model, {
          excludeAccountIds: attemptedByokAccountIds,
        }))?.account ?? null
      : await pool.getNextAccount(providerName);

    // Track BYOK exhausted-fallback attempts so the same exhausted key isn't
    // retried within the same refresh cycle. BYOK's exhausted tier lives inside
    // findAccountForModel; we just record the attempt here for cycle tracking.
    if (account && providerName === "byok" && account.status === "exhausted") {
      pool.markExhaustedTried("byok", account.id);
    }

    // Fallback for non-BYOK: no active account available — try an exhausted
    // account once per refresh cycle (respects 24h grace period inside
    // getExhaustedFallbackAccount). BYOK handles its own exhausted tier above.
    if (!account && providerName !== "byok") {
      const exhausted = await pool.getExhaustedFallbackAccount(providerName);
      if (exhausted) {
        pool.markExhaustedTried(providerName, exhausted.id);
        account = exhausted;
      }
    }

    if (!account) {
      // Distinguish "never had a candidate" from "ran out of candidates after
      // failures". BYOK prefixes often hold a single key, so attempt 2 always
      // comes up empty once that key is excluded — throwing the pool message
      // here would discard the real upstream error from attempt 1 and report a
      // routing/config problem that does not exist.
      if (attemptsMade > 0) break;
      throw new Error(
        `No active accounts available for provider: ${providerName}`
      );
    }
    if (providerName === "byok") attemptedByokAccountIds.add(account.id);
    attemptsMade++;
    lastAccountId = account.id;
    lastAccountEmail = account.email;

    const startTime = Date.now();
    let tracked = false;

    try {
      pool.trackRequestStart(account.id);
      tracked = true;
      const result = stream
        ? await provider.chatCompletionStream(account, compressedRequest)
        : await provider.chatCompletion(account, compressedRequest);

      const durationMs = Date.now() - startTime;

      if (result.success) {
        // If provider refreshed tokens internally, persist them to database
        if (result.tokens) {
          await pool.updateTokens(account.id, result.tokens);
        }
        await pool.markUsed(account.id);
        // Reactivate an account that was served from the exhausted fallback
        // tier — the request succeeded, so the account is actually usable.
        // Driven by real request outcome, NOT by the quota tracker.
        if (account.status === "exhausted") {
          await pool.markActiveFromExhausted(account.id);
        }
        return { result, account, provider: providerName, durationMs, compressionStats };
      }

      pool.trackRequestEnd(account.id);
      tracked = false;

      // Record the provider's own classification of this failure. Reset every
      // attempt so the flags describe the LAST failure, not any earlier one.
      lastRateLimited = result.rateLimited === true;
      lastQuotaExhausted = result.quotaExhausted === true;

      // Client-side model errors should not poison accounts. A wrong model ID
      // is a bad request, not an account/session failure, so stop retrying and
      // let the API layer return an invalid_model response.
      if (isNonAccountRequestError(result.error)) {
        throw new Error(result.error || `Invalid model: ${compressedRequest.model}`);
      }

      // Handle rate limiting (429) — temporary, don't mark exhausted
      if (result.rateLimited) {
        lastError = result.error || "Rate limited";
        continue; // Try next account without poisoning this one
      }

      // Handle quota exhaustion (402 / 403 without PAYG).
      //
      // Trust upstream: if the provider reports quota exhausted, mark it
      // and move on. For Qoder, the next warmup tick will re-fetch
      // /activity and /quota/usage and flip the account back to active
      // automatically if Qoder reports remaining > 0 again. We accept the
      // occasional false-exhaust (lifted within one warmup cycle) in
      // exchange for never serving a known-bad account on retry.
      if (result.quotaExhausted) {
        // If this account was served from the exhausted-fallback tier (its
        // status was already "exhausted" before this attempt), the probe just
        // confirmed it is still out of credits upstream — stamp it checked.
        const wasExhaustedFallback = account.status === "exhausted";
        await pool.markExhausted(account.id);
        if (wasExhaustedFallback) {
          await pool.markExhaustedChecked(account.id);
        }
        lastError = result.error || "Quota exhausted";
        continue; // Try next account
      }

      // Handle token refresh
      if (
        result.error?.includes("expired") ||
        result.error?.includes("401")
      ) {
        const refreshResult = await provider.refreshToken(account);
        if (refreshResult.success && refreshResult.tokens) {
          // Parse tokens string to store as jsonb
          let parsedTokens: unknown;
          try {
            parsedTokens = JSON.parse(refreshResult.tokens);
          } catch {
            parsedTokens = refreshResult.tokens;
          }
          await pool.updateTokens(account.id, parsedTokens);
          // Retry with same account after refresh
          pool.trackRequestStart(account.id);
          tracked = true;
          const retryResult = stream
            ? await provider.chatCompletionStream(account, compressedRequest)
            : await provider.chatCompletion(account, compressedRequest);

          if (retryResult.success) {
            await pool.markUsed(account.id);
            if (account.status === "exhausted") {
              await pool.markActiveFromExhausted(account.id);
            }
            return {
              result: retryResult,
              account,
              provider: providerName,
              durationMs: Date.now() - startTime,
              compressionStats,
            };
          }
          pool.trackRequestEnd(account.id);
          tracked = false;
        }
        await pool.markTransientFailure(account.id, result.error || "Auth failed");
        lastError = result.error || "Auth failed";
        continue;
      }

      // Generic error - check if transient (network/timeout) or permanent
      if (isTransientError(result.error || "")) {
        await pool.markTransientFailure(account.id, result.error || "Transient error");
      } else {
        await pool.markError(account.id, result.error || "Unknown error");
      }
      lastError = result.error || "Unknown error";
    } catch (error) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      if (tracked) {
        pool.trackRequestEnd(account.id);
        tracked = false;
      }
      if (isNonAccountRequestError(errMsg)) {
        throw error;
      }
      // A thrown error carries no provider flags — classify it from the message.
      lastRateLimited = false;
      lastQuotaExhausted = false;
      if (errMsg.includes("expired") || errMsg.includes("401")) {
        await pool.markTransientFailure(account.id, errMsg);
      } else if (isTransientError(errMsg)) {
        await pool.markTransientFailure(account.id, errMsg);
      } else {
        await pool.markError(account.id, errMsg);
      }
      lastError = errMsg;
    }
  }

  throw new AllAccountsFailedError({
    provider: providerName,
    upstreamError: lastError,
    attempts: attemptsMade,
    rateLimited: lastRateLimited,
    quotaExhausted: lastQuotaExhausted,
    lastAccountId,
    lastAccountEmail,
  });
}

// Re-exported from the provider registry (single source of truth). Kept as
// named exports here so existing import sites (proxy/index.ts, api/stats.ts,
// auth/runner.ts, api/image-studio.ts, auth/warmup-runner.ts) stay unchanged.
export { providers, getAllModels, type ProviderName };
