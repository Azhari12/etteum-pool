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
    normalized.includes("unsupported parameter")
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

