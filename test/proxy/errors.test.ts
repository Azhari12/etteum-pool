import { describe, expect, test } from "bun:test";
import {
  extractHttpStatus,
  isBadUpstreamRequest,
  isContentModerationError,
  isInvalidModelError,
  isNonAccountRequestError,
  isTransientError,
} from "../../src/proxy/errors";

describe("proxy error classification", () => {
  test("detects invalid model errors using existing phrases", () => {
    expect(isInvalidModelError("invalid_model_id: claude-x")).toBe(true);
    expect(isInvalidModelError("Invalid model requested")).toBe(true);
    expect(isInvalidModelError("MODEL_NOT_FOUND")).toBe(true);
    expect(isInvalidModelError("No such model: foo")).toBe(true);
    expect(isInvalidModelError("The 'gpt-5.5-xhigh' model is not supported when using Codex with a ChatGPT account.")).toBe(true);
  });

  test("does not classify unrelated errors as invalid model", () => {
    expect(isInvalidModelError(undefined)).toBe(false);
    expect(isInvalidModelError("")).toBe(false);
    expect(isInvalidModelError("upstream timeout")).toBe(false);
  });

  test("detects bad upstream request errors", () => {
    expect(isBadUpstreamRequest("Improperly formed request body")).toBe(true);
    expect(isBadUpstreamRequest("HTTP 400: {\"detail\":\"Unsupported parameter: max_output_tokens\"}")).toBe(true);
    expect(isBadUpstreamRequest("quota exhausted")).toBe(false);
  });

  test("detects content moderation errors", () => {
    expect(isContentModerationError("sensitive content detected")).toBe(true);
    expect(isContentModerationError("系统检测到敏感内容")).toBe(true);
    expect(isContentModerationError("temporary auth error")).toBe(false);
  });

  test("groups client-side errors that should not poison accounts", () => {
    expect(isNonAccountRequestError("invalid model")).toBe(true);
    expect(isNonAccountRequestError("improperly formed request")).toBe(true);
    expect(isNonAccountRequestError("Unsupported parameter: max_output_tokens")).toBe(true);
    // Content moderation is a content issue, not account issue — don't retry
    expect(isNonAccountRequestError("content moderation")).toBe(true);
    expect(isNonAccountRequestError("Content moderation: Your input was flagged")).toBe(true);
    expect(isNonAccountRequestError("flagged as potentially sensitive")).toBe(true);
    expect(isNonAccountRequestError("401 unauthorized")).toBe(false);
  });
});

describe("extractHttpStatus", () => {
  test("reads the status out of every provider's formatting", () => {
    expect(extractHttpStatus('HTTP 502: <!DOCTYPE html>')).toBe(502);
    expect(extractHttpStatus("upstream returned (503)")).toBe(503);
    expect(extractHttpStatus("status 429 from provider")).toBe(429);
    expect(extractHttpStatus("status code: 500")).toBe(500);
    expect(extractHttpStatus("HTTP/400 bad request")).toBe(400);
  });

  test("returns null when there is no status to read", () => {
    expect(extractHttpStatus(undefined)).toBeNull();
    expect(extractHttpStatus("")).toBeNull();
    expect(extractHttpStatus("socket hang up")).toBeNull();
    // Not a status code — must not be mistaken for one.
    expect(extractHttpStatus("model deepseek-v3 unavailable")).toBeNull();
  });
});

describe("isTransientError", () => {
  test("classifies upstream 5xx by status regardless of formatting", () => {
    expect(isTransientError('HTTP 502: <!DOCTYPE html><html>cloudflare</html>')).toBe(true);
    expect(isTransientError("HTTP 500: internal")).toBe(true);
    expect(isTransientError("upstream returned (503)")).toBe(true);
    expect(isTransientError("HTTP 429: slow down")).toBe(true);
  });

  test("still treats network failures as transient", () => {
    expect(isTransientError("socket hang up")).toBe(true);
    expect(isTransientError("fetch failed")).toBe(true);
    expect(isTransientError("ETIMEDOUT")).toBe(true);
    expect(isTransientError("Stream read timeout")).toBe(true);
    expect(isTransientError("Kiro stream error")).toBe(true);
    expect(isTransientError("CodeBuddy stream failed: boom")).toBe(true);
  });

  test("does not treat an upstream error message as a stream error", () => {
    // Regression: the old substring check matched "...upstream error" via
    // "stream error", so any upstream complaint was silently transient.
    expect(isTransientError("Hoshi upstream error")).toBe(false);
    expect(isTransientError("BYOK upstream error for model x")).toBe(false);
  });

  test("keeps account-level failures out of the transient bucket", () => {
    expect(isTransientError("HTTP 401: invalid api key")).toBe(false);
    expect(isTransientError("HTTP 403: forbidden")).toBe(false);
    expect(isTransientError("HTTP 404: no such endpoint")).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError("")).toBe(false);
  });
});
