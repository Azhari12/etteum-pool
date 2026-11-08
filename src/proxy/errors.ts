/**
 * Pull an HTTP status code out of a provider error string.
 *
 * Providers format upstream failures inconsistently — BYOK emits
 * "HTTP 502: <body>", others emit "(502)" or "status 502" — so classification
 * has to handle every shape. Matching only one of them silently mis-sorts the
 * rest (a 502 gets treated as a permanent account failure instead of a
 * transient upstream blip).
 */
export function extractHttpStatus(error?: string): number | null {
  if (!error) return null;
  const match =
    error.match(/\bhttp[\s/]*(?:status[\s:]*)?([1-5]\d{2})\b/i) ||
    error.match(/\bstatus(?:\s*code)?[\s:=]*([1-5]\d{2})\b/i) ||
    error.match(/\(([1-5]\d{2})\)/);
  return match ? Number(match[1]) : null;
}

export function isInvalidModelError(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes("invalid_model_id") ||
    normalized.includes("invalid model") ||
    normalized.includes("model_not_found") ||
    normalized.includes("no such model") ||
    normalized.includes("model is not supported") ||
    normalized.includes("model not supported")
  );
}

export function isBadUpstreamRequest(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes("improperly formed request") ||
    normalized.includes("unsupported parameter") ||
    // Content too large for the model's context window. Deterministic — every
    // account returns the same rejection, so retrying just burns attempts and
    // buries the real cause behind "All accounts failed".
    isContextOverflowError(normalized)
  );
}

/**
 * The request exceeded the model's context window.
 *
 * Providers word this differently: CodeBuddy China returns
 * `"prompt is too long: 1049004 tokens > 1048576 maximum"` (code 11115),
 * Anthropic returns "prompt is too long", OpenAI "context_length_exceeded".
 * All are the caller's problem — shorten the prompt, don't switch accounts.
 */
export function isContextOverflowError(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes("prompt is too long") ||
    normalized.includes("content too long") ||
    normalized.includes("context_length_exceeded") ||
    normalized.includes("context length exceeded") ||
    normalized.includes("maximum context length") ||
    normalized.includes("exceeds the model limit") ||
    normalized.includes("exceeds the maximum") ||
    // "1049004 tokens > 1048576 maximum" — the numeric shape CBC uses.
    /\d+\s*tokens?\s*>\s*\d+\s*maximum/.test(normalized) ||
    // CodeBuddy China's numeric error code for oversized prompts.
    normalized.includes('"code":11115')
  );
}

export function isContentModerationError(error?: string): boolean {
  if (!error) return false;
  return (
    error.includes("敏感内容") ||
    error.includes("sensitive content") ||
    error.includes("系统检测到") ||
    error.includes("content moderation") ||
    error.includes("Content moderation") ||
    error.includes("content_filter") ||
    error.includes("flagged as potentially sensitive")
  );
}

/**
 * Whether a failure means the account's credentials/session are dead and it
 * needs a human re-login — i.e. it must NOT be offered to the rotation again.
 *
 * Every other failure is considered recoverable: the account stays eligible so
 * a later request can prove it works again (and flip it back to `active`).
 * Distinguishing these two is what keeps a single transient blip from parking
 * an account in the `error` state forever.
 */
export function isAuthFailureError(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    // Explicit re-login signals used across the providers.
    normalized.includes("session expired") ||
    normalized.includes("re-login required") ||
    normalized.includes("relogin required") ||
    normalized.includes("requires re-login") ||
    normalized.includes("requires browser re-login") ||
    normalized.includes("login required") ||
    normalized.includes("token expired") ||
    normalized.includes("refresh token is invalid") ||
    normalized.includes("invalid_grant") ||
    normalized.includes("unauthorized") ||
    normalized.includes("banned") ||
    // Expired/absent credentials.
    normalized.includes("no tokens available") ||
    normalized.includes("no api key available") ||
    // Credential rejections. 401/403 anywhere in the text.
    extractHttpStatus(error) === 401 ||
    extractHttpStatus(error) === 403 ||
    /\b401\b/.test(normalized) ||
    /\b403\b/.test(normalized) ||
    // Account-level anti-abuse restriction (e.g. CodeBuddy CN code 11140
    // "request illegal" / "restricted due to unusual activity"). Re-login
    // cannot fix it, so keep the account out of rotation until a human
    // resolves the restriction — but the error message tells them so.
    normalized.includes("restricted by") ||
    normalized.includes("account restricted") ||
    /\b1114[01]\b/.test(normalized)
  );
}

/**
 * Whether the failure is an ACCOUNT-LEVEL restriction by the upstream
 * (anti-abuse / policy), e.g. CodeBuddy CN code 11140 "request illegal" with
 * "Your account has been restricted due to unusual activity".
 *
 * These must not merely be retried or re-logged — the account is unusable
 * until a human resolves it upstream. The router auto-disables such accounts
 * (status=error, enabled=false) and persists the reason so the dashboard
 * shows it.
 */
export function isAccountRestrictedError(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes("restricted by") ||
    normalized.includes("account restricted") ||
    normalized.includes("has been restricted") ||
    normalized.includes("unusual activity") ||
    normalized.includes("异常行为") ||
    normalized.includes("已被限制") ||
    /\b1114[01]\b/.test(normalized)
  );
}

/**
 * Errors that are caused by the request content itself, not the account.
 * These should NOT be retried with different accounts since the same content
 * will trigger the same error regardless of which account is used.
 */
export function isNonAccountRequestError(error?: string): boolean {
  if (!error) return false;
  return (
    isInvalidModelError(error) ||
    isContentModerationError(error) ||
    isBadUpstreamRequest(error)
  );
}

/**
 * Upstream statuses that mean "try again / try elsewhere", not "bad account".
 *
 * 400 is included because a malformed-request complaint is never the account's
 * fault — the genuinely unrecoverable 400s (invalid model, moderation, bad
 * params) are caught earlier by isNonAccountRequestError, which stops the retry
 * loop outright. 401/403/404 are deliberately absent: those point at the
 * account's credentials or base_url and should mark it.
 */
const TRANSIENT_STATUSES = new Set([400, 408, 425, 429, 500, 502, 503, 504, 522, 524]);

/**
 * Transient errors that are temporary and should not permanently mark an account as errored.
 * These include network issues, timeouts, rate limits, upstream server errors,
 * and bad-request errors that are caused by the request format (not the account).
 * Account stays "active" but error is logged.
 */
export function isTransientError(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();

  // Status-code first: covers every provider's formatting ("HTTP 502: ...",
  // "(502)", "status 502") instead of only the parenthesised variant.
  const status = extractHttpStatus(error);
  if (status !== null && TRANSIENT_STATUSES.has(status)) return true;

  return (
    // Network / connectivity
    normalized.includes("timeout") ||
    normalized.includes("etimedout") ||
    normalized.includes("request timeout") ||
    normalized.includes("network error") ||
    normalized.includes("econnreset") ||
    normalized.includes("econnrefused") ||
    normalized.includes("enotfound") ||
    normalized.includes("socket hang up") ||
    normalized.includes("fetch failed") ||
    normalized.includes("dns") ||
    normalized.includes("connection") ||
    normalized.includes("aborted") ||
    normalized.includes("eai again") ||
    normalized.includes("temporary failure") ||
    // Upstream server errors (not account-specific)
    normalized.includes("internal server error") ||
    normalized.includes("bad gateway") ||
    normalized.includes("service unavailable") ||
    normalized.includes("gateway timeout") ||
    // Rate limiting (temporary)
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    // Bad request format (not account issue — request content caused it)
    normalized.includes("parse message failed") ||
    normalized.includes("invalid request") ||
    // Stream errors (temporary). Word-anchored so an upstream message ending in
    // "...upstream error" is not swallowed by the "stream error" substring.
    /\bstream (error|failed)\b/.test(normalized) ||
    normalized.includes("stream read timeout")
  );
}

