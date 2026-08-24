import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { db } from "../../db/index";
import { accounts } from "../../db/schema";
import { eq } from "drizzle-orm";
import { config } from "../../config";
import { decrypt } from "../../utils/crypto";

/**
 * BYOK (Bring Your Own Key) Provider
 *
 * Memungkinkan user menambahkan custom AI provider (OpenRouter, Together, Groq, dll)
 * dengan API key mereka sendiri. Support OpenAI dan Anthropic formats.
 *
 * Storage:
 * - provider: "byok"
 * - email: label/nama provider (e.g., "openrouter", "myrouter")
 * - password: encrypted API key (XOR + base64)
 * - tokens: JSON { base_url, format, models[], model_prefix, headers }
 *
 * Model routing via prefix:
 * - User define label "openrouter" + models ["gpt-4o", "claude-sonnet-4.6"]
 * - Available: "openrouter-gpt-4o", "openrouter-claude-sonnet-4.6"
 * - Request { model: "openrouter-gpt-4o" } → forward ke base_url dengan model "gpt-4o"
 */

interface ByokTokens {
  base_url: string;
  api_key?: string; // kept in tokens for reference only, actual key is in password (encrypted)
  format: "openai" | "anthropic" | "auto";
  models: string[];
  model_prefix: string;
  headers?: Record<string, string>;
  /** Human-friendly key label inside a BYOK provider group (e.g. default, trial-1). */
  key_label?: string;
  /** Optional future-proofing for weighted balancing. Defaults to 1. */
  weight?: number;
  /** Lower number is preferred for sequential balancing. Defaults to account id order. */
  priority?: number;
}

interface CachedByokAccount {
  account: Account;
  config: ByokTokens;
  expiresAt: number;
}

interface ByokSelectionOptions {
  excludeAccountIds?: Set<number>;
  loadBalancingMethod?: string;
  getInFlightCount?: (accountId: number) => number;
}

export class ByokProvider extends BaseProvider {
  name = "byok";
  override supportedModels: ModelInfo[] = [];
  override isFallback = false;
  override nativeFormat: "openai" | "anthropic" = "openai";

  // Synchronous prefix → accounts cache (required for ownsModel sync check).
  // Multiple accounts can share a model_prefix; selection/load-balancing happens per prefix.
  private prefixCache = new Map<string, CachedByokAccount[]>();
  private prefixes: string[] = [];
  private cacheExpiry = 0;
  private readonly CACHE_TTL = 10_000; // 10 seconds
  private refreshPromise: Promise<void> | null = null;
  private lastIndexByPrefix = new Map<string, number>();

  // ── Cache Management ──────────────────────────────────────────────

  /**
   * Refresh the prefix cache from the database.
   * Deduplicates concurrent calls so only one DB query runs at a time.
   */
  private async refreshCache(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.loadFromDb();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async loadFromDb(): Promise<void> {
    const byokAccounts = await db
      .select()
      .from(accounts)
      .where(eq(accounts.provider, "byok"));

    // Build new data in temporary variables first to avoid race condition
    const newPrefixCache = new Map<string, CachedByokAccount[]>();
    const newPrefixSet = new Set<string>();
    const newSupportedModels: ModelInfo[] = [];
    const modelIds = new Set<string>();

    for (const account of byokAccounts) {
      if (!account.enabled) continue;
      // Include error accounts so routing still claims their prefix.
      // The router will handle retries/failures; we must not let their
      // models fall through to the fallback provider (Kiro).
      if (account.status !== "active" && account.status !== "error") continue;

      const tokens = this.parseTokens(account.tokens);
      if (!tokens?.base_url || !tokens.models?.length) continue;

      const prefix = tokens.model_prefix || account.email;
      const expiresAt = Date.now() + this.CACHE_TTL;
      const entry: CachedByokAccount = { account, config: tokens, expiresAt };

      const existing = newPrefixCache.get(prefix) || [];
      existing.push(entry);
      newPrefixCache.set(prefix, existing);
      newPrefixSet.add(prefix);

      for (const model of tokens.models) {
        const modelId = `${prefix}-${model}`;
        if (modelIds.has(modelId)) continue;
        modelIds.add(modelId);
        newSupportedModels.push({
          id: modelId,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: `byok:${prefix}`,
          context_window: 200_000,
          max_output: 8192,
          // BYOK upstream capability is opaque to the proxy — we don't know
          // which models support vision. Default to true so the router's
          // vision gate doesn't reject image requests before they even reach
          // the upstream (which is the real arbiter). If the upstream model
          // is text-only, the upstream returns its own error on the request.
          vision: true,
          thinking: false,
        });
      }
    }

    for (const entries of newPrefixCache.values()) {
      entries.sort((a, b) => {
        const priorityA = Number(a.config.priority ?? Number.POSITIVE_INFINITY);
        const priorityB = Number(b.config.priority ?? Number.POSITIVE_INFINITY);
        if (priorityA !== priorityB) return priorityA - priorityB;
        return a.account.id - b.account.id;
      });
    }

    // Atomically swap in the new data
    this.prefixCache = newPrefixCache;
    this.prefixes = Array.from(newPrefixSet).sort((a, b) => b.length - a.length);
    this.supportedModels = newSupportedModels;
    this.cacheExpiry = Date.now() + this.CACHE_TTL;
  }

  /** Ensure cache is fresh, refreshing if stale. */
  private async ensureCache(): Promise<void> {
    if (Date.now() < this.cacheExpiry) return;
    await this.refreshCache();
  }

  /** Force-refresh cache (called after BYOK CRUD operations). */
  async refreshModelsCache(): Promise<void> {
    this.cacheExpiry = 0;
    await this.refreshCache();
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private parseTokens(raw: unknown): ByokTokens | null {
    if (!raw) return null;
    try {
      const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
      return obj as ByokTokens;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the API key for an account.
   * The real key lives in `password` (XOR-encrypted); tokens.api_key is optional.
   */
  private getApiKey(account: Account): string {
    try {
      return decrypt(account.password);
    } catch {
      // Fallback: try tokens.api_key (shouldn't happen, but defensive)
      const tokens = this.parseTokens(account.tokens);
      return tokens?.api_key || "";
    }
  }

  /**
   * Detect API format from base_url or use explicit setting.
   */
  private detectFormat(config: ByokTokens): "openai" | "anthropic" {
    if (config.format && config.format !== "auto") return config.format;
    const url = config.base_url.toLowerCase();
    if (url.includes("anthropic.com") || url.endsWith("/messages")) return "anthropic";
    return "openai";
  }

  /**
   * Strip the BYOK prefix from a model name.
   * "openrouter-gpt-4o" → "gpt-4o"
   */
  private extractModel(prefixedModel: string, prefix: string): string {
    return prefixedModel.startsWith(`${prefix}-`)
      ? prefixedModel.slice(prefix.length + 1)
      : prefixedModel;
  }

  /** Find which BYOK prefix a model belongs to. */
  private findPrefix(model: string): string | null {
    for (const prefix of this.prefixes) {
      if (model.startsWith(`${prefix}-`)) return prefix;
    }
    return null;
  }

  /** Public async helper for account-pool setting lookup. */
  findPrefixForModel(model: string): string | null {
    if (Date.now() >= this.cacheExpiry) {
      this.refreshCache().catch(() => {/* swallow — next call will retry */});
    }
    return this.findPrefix(model);
  }

  // ── Routing (synchronous — required by registry) ──────────────────

  /**
   * Synchronous ownsModel check. The cache MUST be pre-populated
   * (refreshed via refreshModelsCache() at startup and after CRUD).
   */
  override ownsModel(model: string): boolean {
    // If cache is stale, trigger a background refresh but still use last-known
    // prefixes so requests don't fall through to the fallback provider (Kiro).
    if (Date.now() >= this.cacheExpiry) {
      // Fire-and-forget: refresh in background, don't block routing
      this.refreshCache().catch(() => {/* swallow — next call will retry */});
    }
    return this.findPrefix(model) !== null;
  }

  /**
   * Find the BYOK account that owns a given model (by prefix) and select one
   * key from that prefix group using the configured load-balancing strategy.
   * Called by pool.getAccountForModel() for async account selection.
   */
  async findAccountForModel(
    model: string,
    options: ByokSelectionOptions = {}
  ): Promise<Account | null> {
    await this.ensureCache();
    const prefix = this.findPrefix(model);
    if (!prefix) return null;

    const actualModel = this.extractModel(model, prefix);
    const entries = this.prefixCache.get(prefix) || [];
    const excluded = options.excludeAccountIds || new Set<number>();

    // Prefer active keys. Error keys remain in the cache only to keep model
    // ownership claimed; they are tried only if no active key is available.
    const supportsModel = (entry: CachedByokAccount) => entry.config.models.includes(actualModel);
    const notExcluded = (entry: CachedByokAccount) => !excluded.has(entry.account.id);
    let candidates = entries.filter((entry) =>
      entry.account.enabled && entry.account.status === "active" && supportsModel(entry) && notExcluded(entry)
    );

    if (candidates.length === 0) {
      candidates = entries.filter((entry) =>
        entry.account.enabled && entry.account.status === "error" && supportsModel(entry) && notExcluded(entry)
      );
    }

    // Last-resort tier: exhausted accounts. One-shot per refresh cycle — the
    // pool's exhaustedTriedByProvider set (keyed "byok") prevents retrying the
    // same exhausted key within the same cycle. The caller (router) will
    // flip the account back to "active" if this attempt succeeds.
    if (candidates.length === 0) {
      candidates = entries.filter((entry) =>
        entry.account.enabled && entry.account.status === "exhausted" && supportsModel(entry) && notExcluded(entry)
      );
    }

    if (candidates.length === 0) return null;
    return this.selectAccount(prefix, candidates, options).account;
  }

  private selectAccount(
    prefix: string,
    candidates: CachedByokAccount[],
    options: ByokSelectionOptions
  ): CachedByokAccount {
    if (candidates.length === 1) return candidates[0]!;

    const getLoad = options.getInFlightCount || (() => 0);
    const method = options.loadBalancingMethod || "round_robin";

    if (method === "sequential") {
      for (const candidate of candidates) {
        if (getLoad(candidate.account.id) === 0) return candidate;
      }
      return candidates[0]!;
    }

    if (method === "least_inflight") {
      return candidates.reduce((best, candidate) =>
        getLoad(candidate.account.id) < getLoad(best.account.id) ? candidate : best
      );
    }

    // Round robin (default), with least-in-flight tie-break so bursty workloads
    // don't pile up on a slow upstream key.
    const startIdx = ((this.lastIndexByPrefix.get(prefix) ?? -1) + 1) % candidates.length;
    let selected = candidates[startIdx]!;
    let selectedIdx = startIdx;
    let selectedLoad = getLoad(selected.account.id);

    for (let i = 1; i < candidates.length; i++) {
      const idx = (startIdx + i) % candidates.length;
      const candidate = candidates[idx]!;
      const load = getLoad(candidate.account.id);
      if (load < selectedLoad) {
        selected = candidate;
        selectedIdx = idx;
        selectedLoad = load;
        if (load === 0) break;
      }
    }

    this.lastIndexByPrefix.set(prefix, selectedIdx);
    return selected;
  }

  /** Get all BYOK models for /v1/models endpoint. */
  async getAllByokModels(): Promise<ModelInfo[]> {
    await this.ensureCache();
    return this.supportedModels;
  }

  // ── Provider Interface ─────────────────────────────────────────────

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const tokens = this.parseTokens(account.tokens);
    if (!tokens) return { success: false, error: "Invalid BYOK configuration" };

    const format = this.detectFormat(tokens);
    const actualModel = this.extractModel(request.model, tokens.model_prefix);

    return format === "anthropic"
      ? this.chatCompletionAnthropic(account, tokens, actualModel, request)
      : this.chatCompletionOpenAI(account, tokens, actualModel, request);
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const tokens = this.parseTokens(account.tokens);
    if (!tokens) return { success: false, error: "Invalid BYOK configuration" };

    const format = this.detectFormat(tokens);
    const actualModel = this.extractModel(request.model, tokens.model_prefix);

    return format === "anthropic"
      ? this.chatCompletionStreamAnthropic(account, tokens, actualModel, request)
      : this.chatCompletionStreamOpenAI(account, tokens, actualModel, request);
  }

  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: true }; // BYOK keys are static — user manages their own
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.parseTokens(account.tokens);
    return !!(tokens?.base_url && tokens?.models?.length);
  }

  async fetchQuota(): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    return {
      success: true,
      quota: { limit: -1, remaining: -1, used: 0, resetAt: null },
    };
  }

  // ── OpenAI-compatible ──────────────────────────────────────────────

  /**
   * Normalize an upstream `delta.content` / `content` value into a plain
   * string. Some BYOK upstreams stream content as an array of content blocks
   * (`[{type:"text", text:"..."}]`) or a bare object; concatenating such a
   * value with += would coerce via String() and yield "[object Object]" in
   * the final response. (Same fix as CodeBuddy CN's normalizeContent.)
   */
  private normalizeDeltaContent(content: unknown): string {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((block: any) => {
          if (block == null) return "";
          if (typeof block === "string") return block;
          if (typeof block.text === "string") return block.text;
          if (typeof block.content === "string") return block.content;
          if (typeof block === "object") return this.normalizeDeltaContent(block);
          return "";
        })
        .filter(Boolean)
        .join("");
    }
    if (typeof content === "object") {
      const obj = content as any;
      if (typeof obj.text === "string") return obj.text;
      if (typeof obj.content === "string") return obj.content;
      if (obj.content != null) return this.normalizeDeltaContent(obj.content);
    }
    return "";
  }

  /**
   * Normalize a request's messages for an OpenAI-compatible upstream.
   *
   * Clients (the assistant CLI) send images in Anthropic shape:
   *   { type: "image", source: { type: "base64", media_type, data } }
   * OpenAI-compatible endpoints expect:
   *   { type: "image_url", image_url: { url: "data:<mime>;base64,<data>" } }
   * Without this conversion, BYOK image requests were being rejected upstream
   * with a generic "unsupported content" error that looked like the model
   * lacked vision — but it was really a format mismatch. (See CodeBuddy CN
   * provider's cleanMessages for the same conversion.)
   *
   * Pure-text array content is collapsed back to a plain string for backwards
   * compatibility with non-vision OpenAI models that reject array content.
   */
  private normalizeMessagesForOpenAI(messages: any[]): any[] {
    return messages.map((msg) => {
      if (!Array.isArray(msg.content)) return msg;

      const output: any[] = [];
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text") {
          output.push({ type: "text", text: block.text || "" });
        } else if (block.type === "image_url" && block.image_url) {
          // Already OpenAI shape — pass through (normalize url field).
          const url = typeof block.image_url === "string"
            ? block.image_url
            : block.image_url.url;
          if (url) output.push({ type: "image_url", image_url: { url } });
        } else if (block.type === "image" && block.source) {
          // Anthropic shape → OpenAI image_url with data URL.
          const dataUrl = block.source.type === "base64"
            ? `data:${block.source.media_type || "image/png"};base64,${block.source.data}`
            : block.source.url || "";
          if (dataUrl) {
            output.push({ type: "image_url", image_url: { url: dataUrl } });
          }
        }
        // Other block types (tool_use, tool_result, etc.) are handled by
        // toOpenAIRequest elsewhere for OpenAI wire format; here we only fix
        // images so we don't regress the existing tool-call path.
      }

      // Collapse to plain string if only text blocks remain.
      const hasOnlyText = output.length > 0 && output.every((b) => b.type === "text");
      if (hasOnlyText) {
        return { ...msg, content: output.map((b) => b.text).join("\n") };
      }
      return { ...msg, content: output };
    });
  }

  private async chatCompletionOpenAI(
    account: Account,
    tokens: ByokTokens,
    actualModel: string,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    const url = `${tokens.base_url.replace(/\/$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      ...tokens.headers,
    };

    const body: Record<string, unknown> = {
      model: actualModel,
      messages: request.messages,
      stream: false,
    };
    this.appendOptionalParams(body, request);

    // Convert Anthropic-shape image blocks → OpenAI image_url so vision works
    // against OpenAI-compatible BYOK upstreams.
    if (Array.isArray(body.messages)) {
      body.messages = this.normalizeMessagesForOpenAI(body.messages);
    }

    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", rateLimited: true };
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      // Check if response is SSE (some providers return SSE even when stream: false)
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        // Parse SSE response - aggregate streaming chunks into single completion
        const text = await response.text();
        const lines = text.split("\n").filter((line) => line.startsWith("data: "));
        
        let aggregatedContent = "";
        let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
        let chunkId = "";
        let chunkModel = "";
        let created = 0;
        let finishReason: string | null = null;
        
        for (const line of lines) {
          const payload = line.slice(6).trim();
          if (payload === "[DONE]" || !payload || payload.startsWith(":")) continue;
          
          try {
            const chunk = JSON.parse(payload);
            
            // Check for error response
            if (chunk.error) {
              return { 
                success: false, 
                error: chunk.error.message || chunk.error.code || "Upstream error"
              };
            }
            
            // Extract metadata from first chunk
            if (!chunkId && chunk.id) chunkId = chunk.id;
            if (!chunkModel && chunk.model) chunkModel = chunk.model;
            if (!created && chunk.created) created = chunk.created;
            
            // Aggregate content from delta. Some upstreams stream `content`
            // as an array of blocks or a bare object instead of a string —
            // concatenating those with += would coerce to "[object Object]".
            // Normalize to a real string first (mirrors CodeBuddy CN's
            // normalizeContent).
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content != null) {
              aggregatedContent += this.normalizeDeltaContent(delta.content);
            }
            
            // Capture finish reason
            if (chunk.choices?.[0]?.finish_reason) {
              finishReason = chunk.choices[0].finish_reason;
            }
            
            // Capture usage from final chunk
            if (chunk.usage) {
              usage = chunk.usage;
            }
          } catch {
            // Skip malformed chunks
          }
        }
        
        if (!aggregatedContent && !usage) {
          return { success: false, error: "No valid data in SSE response" };
        }
        
        // Build non-streaming response object
        const completionResponse: ChatCompletionResponse = {
          id: chunkId || this.generateId(),
          object: "chat.completion",
          created: created || Math.floor(Date.now() / 1000),
          model: request.model, // Return original prefixed model to client
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: aggregatedContent,
            },
            finish_reason: finishReason || "stop",
          }],
          usage: {
            prompt_tokens: usage.prompt_tokens || 0,
            completion_tokens: usage.completion_tokens || this.estimateTokens(aggregatedContent),
            total_tokens: usage.total_tokens || 0,
          },
        };
        
        const promptTokens = completionResponse.usage.prompt_tokens;
        const completionTokens = completionResponse.usage.completion_tokens;
        
        return {
          success: true,
          response: completionResponse,
          promptTokens,
          completionTokens,
          tokensUsed: promptTokens + completionTokens,
        };
      }

      const data = (await response.json()) as any;
      // Upstream may return { error: {...} } instead of choices (e.g. pool
      // upstream with no active accounts for the model). Surface the real reason.
      if (data?.error) {
        const errMsg = data.error.message || data.error.code || "Upstream error";
        console.warn(`[BYOK] upstream error for model ${request.model} (account ${account.email}): ${errMsg}`);
        return { success: false, error: `upstream: ${errMsg}` };
      }
      const choice = data.choices?.[0];
      if (!choice) return { success: false, error: "No choices in response" };

      const promptTokens = data.usage?.prompt_tokens || this.estimateMessagesTokens(request.messages);
      const completionTokens = data.usage?.completion_tokens || this.estimateTokens(
        typeof choice.message?.content === "string" ? choice.message.content : ""
      );

      // Return original prefixed model to the client
      data.model = request.model;

      return {
        success: true,
        response: data,
        promptTokens,
        completionTokens,
        tokensUsed: promptTokens + completionTokens,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async chatCompletionStreamOpenAI(
    account: Account,
    tokens: ByokTokens,
    actualModel: string,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    const url = `${tokens.base_url.replace(/\/$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "text/event-stream",
      ...tokens.headers,
    };

    const body: Record<string, unknown> = {
      model: actualModel,
      messages: request.messages,
      stream: true,
    };
    this.appendOptionalParams(body, request);

    // Convert Anthropic-shape image blocks → OpenAI image_url (vision support).
    if (Array.isArray(body.messages)) {
      body.messages = this.normalizeMessagesForOpenAI(body.messages);
    }

    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", rateLimited: true };
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      // Pass upstream stream through, rewriting model and id
      const id = this.generateId();
      const model = request.model;
      const encoder = new TextEncoder();
      const upstream = response.body;
      const self = this;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = upstream.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let sawAnyChunk = false;

          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const parts = buffer.split("\n\n");
              buffer = parts.pop() || "";

              for (const part of parts) {
                const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
                if (!dataLine) continue;

                const payload = dataLine.slice(6).trim();
                if (payload === "[DONE]") {
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                  return;
                }

                try {
                  const chunk = JSON.parse(payload);

                  // Some upstreams (e.g. nrimoae.dev, which is itself a pool)
                  // stream an error object instead of a choices array when the
                  // underlying model/account is unavailable. Surface it as a
                  // stream error so the client doesn't receive a silent empty
                  // completion — and log the real upstream reason.
                  if (chunk.error) {
                    const errMsg = chunk.error.message || chunk.error.code || "upstream error";
                    console.warn(`[BYOK] upstream stream error for model ${model} (account ${account.email}): ${errMsg}`);
                    const errChunk = {
                      id,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model,
                      choices: [{
                        index: 0,
                        delta: { content: `[upstream error: ${errMsg}]` },
                        finish_reason: "stop",
                      }],
                    };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                    return;
                  }

                  chunk.model = model;
                  chunk.id = id;
                  // Normalize delta.content that some upstreams send as an
                  // array/object into a plain string before passthrough.
                  const delta = chunk.choices?.[0]?.delta;
                  if (delta?.content != null) {
                    const normalized = self.normalizeDeltaContent(delta.content);
                    if (normalized) delta.content = normalized;
                    else delete delta.content;
                  }
                  sawAnyChunk = true;
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                } catch { /* skip malformed */ }
              }
            }

            // Fallback: upstream closed without ever emitting a chunk (some
            // providers return an empty SSE body or close immediately). Synthesize
            // a minimal empty-content chunk + [DONE] so the client doesn't hang
            // waiting for content that will never arrive.
            if (!sawAnyChunk) {
              console.warn(`[BYOK] upstream returned no stream chunks for model ${model} (account ${account.email}) — synthesizing empty completion`);
              const empty = {
                id,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(empty)}\n\n`));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (err) {
            try { controller.error(err); } catch { /* already errored */ }
          }
        },
      });

      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Anthropic Messages API ─────────────────────────────────────────

  private async chatCompletionAnthropic(
    account: Account,
    tokens: ByokTokens,
    actualModel: string,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    const url = `${tokens.base_url.replace(/\/$/, "")}/messages`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      ...tokens.headers,
    };

    const body = this.toAnthropicRequest(request, actualModel, false);

    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", rateLimited: true };
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      const data = await response.json();
      const resp = this.fromAnthropicResponse(data, request.model);
      const promptTokens = resp.usage.prompt_tokens || this.estimateMessagesTokens(request.messages);
      const completionTokens = resp.usage.completion_tokens || 0;

      return {
        success: true,
        response: resp,
        promptTokens,
        completionTokens,
        tokensUsed: promptTokens + completionTokens,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async chatCompletionStreamAnthropic(
    account: Account,
    tokens: ByokTokens,
    actualModel: string,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    const url = `${tokens.base_url.replace(/\/$/, "")}/messages`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Accept": "text/event-stream",
      ...tokens.headers,
    };

    const body = this.toAnthropicRequest(request, actualModel, true);

    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", rateLimited: true };
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      const stream = this.transformAnthropicStream(response.body, request.model);
      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Anthropic Transform Helpers ────────────────────────────────────

  private toAnthropicRequest(
    request: ChatCompletionRequest,
    model: string,
    stream: boolean
  ): Record<string, unknown> {
    const systemParts: string[] = [];
    const messages: Array<{ role: string; content: unknown }> = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemParts.push(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      } else {
        messages.push({ role: msg.role === "tool" ? "user" : msg.role, content: msg.content });
      }
    }

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.max_tokens || 4096,
      stream,
    };

    if (systemParts.length > 0) body.system = systemParts.join("\n\n");
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;

    // Pass tools through in Anthropic's native format so the upstream can
    // emit tool_use blocks. Without this the model has no tools to call,
    // producing empty/malformed tool calls. Convert from OpenAI function
    // schema shape (request.tools = [{ type:"function", function:{name,description,parameters} }])
    // to Anthropic shape ({ name, description, input_schema }).
    if (Array.isArray(request.tools) && request.tools.length > 0) {
      body.tools = request.tools.map((t: any) => ({
        name: t?.function?.name || t?.name,
        description: t?.function?.description || t?.description,
        input_schema: t?.function?.parameters || t?.input_schema || { type: "object", properties: {} },
      })).filter((t: any) => t.name);
    }
    if (request.tool_choice) {
      // OpenAI tool_choice variants → Anthropic. Object {type:"function",function:{name}}
      // → {type:"tool",name}. "auto"/"none"/"required" pass through.
      const tc = request.tool_choice as any;
      if (typeof tc === "string") {
        body.tool_choice = tc === "required" ? "any" : tc;
      } else if (tc?.type === "function" && tc?.function?.name) {
        body.tool_choice = { type: "tool", name: tc.function.name };
      }
    }

    return body;
  }

  private fromAnthropicResponse(data: any, originalModel: string): ChatCompletionResponse {
    const content: any[] = data.content || [];
    const textContent = content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text || "")
      .join("");

    const toolCalls = content
      .filter((c: any) => c.type === "tool_use")
      .map((c: any, i: number) => ({
        id: c.id || `call_${i}`,
        type: "function" as const,
        function: { name: c.name || "", arguments: JSON.stringify(c.input || {}) },
      }));

    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;

    return {
      id: data.id || this.generateId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: originalModel,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: textContent,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        } as any,
        finish_reason: data.stop_reason === "tool_use" ? "tool_calls" : "stop",
      }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };
  }

  /**
   * Transform Anthropic SSE stream → OpenAI-compatible SSE stream.
   */
  private transformAnthropicStream(
    anthropicStream: ReadableStream<Uint8Array>,
    originalModel: string
  ): ReadableStream<Uint8Array> {
    const reader = anthropicStream.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const id = this.generateId();
    let buffer = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let started = false;

    // Track tool blocks being streamed. Anthropic sends:
    //   content_block_start { content_block: { type:"tool_use", id, name, input:{} } }
    //   content_block_delta  { delta: { type:"input_json_delta", partial_json } }
    //   content_block_stop
    // Convert to OpenAI streaming tool_calls shape so the proxy's
    // openAIStreamToAnthropic transform can turn it back into Anthropic
    // tool_use for the client. Without this, tool calls from an
    // Anthropic-format BYOK upstream were silently dropped → "empty tool
    // call" / stuck-response loops.
    const toolBlocks = new Map<number, { callIndex: number; id: string; name: string }>();
    let nextToolCallIndex = 0;

    const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: originalModel,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      };
      return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";

            for (const part of parts) {
              const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
              if (!dataLine) continue;

              const payload = dataLine.slice(6).trim();
              if (payload === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }

              try {
                const event = JSON.parse(payload);

                if (event.type === "message_start") {
                  inputTokens = event.message?.usage?.input_tokens || 0;
                  if (!started) {
                    started = true;
                    controller.enqueue(makeChunk({ role: "assistant" }));
                  }
                }

                if (event.type === "content_block_start") {
                  const block = event.content_block;
                  if (block?.type === "tool_use") {
                    const callIndex = nextToolCallIndex++;
                    toolBlocks.set(event.index, {
                      callIndex,
                      id: block.id || `call_${callIndex}`,
                      name: block.name || "",
                    });
                    // Emit the tool call start with name + empty arguments.
                    controller.enqueue(makeChunk({
                      tool_calls: [{
                        index: callIndex,
                        id: block.id || `call_${callIndex}`,
                        type: "function",
                        function: { name: block.name || "", arguments: "" },
                      }],
                    }));
                  }
                }

                if (event.type === "content_block_delta") {
                  const delta = event.delta;
                  if (delta?.type === "text_delta" && delta.text) {
                    controller.enqueue(makeChunk({ content: delta.text }));
                  } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
                    // Stream tool-call arguments incrementally.
                    const tb = toolBlocks.get(event.index);
                    if (tb) {
                      controller.enqueue(makeChunk({
                        tool_calls: [{
                          index: tb.callIndex,
                          function: { arguments: delta.partial_json },
                        }],
                      }));
                    }
                  }
                }

                if (event.type === "content_block_stop") {
                  // Tool block complete — nothing to emit (OpenAI closes by
                  // finish_reason). Text block already streamed via deltas.
                }

                if (event.type === "message_delta") {
                  outputTokens = event.usage?.output_tokens || 0;
                  // Map Anthropic stop_reason → OpenAI finish_reason.
                  const stopReason = event.delta?.stop_reason;
                  if (stopReason === "tool_use") {
                    controller.enqueue(makeChunk({}, "tool_calls"));
                  } else if (stopReason === "end_turn" || stopReason === "stop_sequence") {
                    controller.enqueue(makeChunk({}, "stop"));
                  } else if (stopReason === "max_tokens") {
                    controller.enqueue(makeChunk({}, "length"));
                  }
                }

                if (event.type === "message_stop") {
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                  return;
                }
              } catch { /* skip malformed */ }
            }
          }

          if (!started) controller.enqueue(makeChunk({ role: "assistant", content: "" }));
          controller.enqueue(makeChunk({}, "stop"));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          try { controller.error(err); } catch { /* already errored */ }
        }
      },
    });
  }

  // ── Shared Utilities ───────────────────────────────────────────────

  private appendOptionalParams(body: Record<string, unknown>, request: ChatCompletionRequest): void {
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.frequency_penalty !== undefined) body.frequency_penalty = request.frequency_penalty;
    if (request.presence_penalty !== undefined) body.presence_penalty = request.presence_penalty;
    if (request.tools) body.tools = request.tools;
    if (request.tool_choice) body.tool_choice = request.tool_choice;
  }
}
