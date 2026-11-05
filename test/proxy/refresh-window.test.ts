// No eligible account may ever be skipped by the refresh guard.
//
// A busy account never passes through warmup, so the 3-day window is enforced
// on the REQUEST path too (chatCompletion / chatCompletionStream). These tests
// pin the decision table so a future refactor can't silently drop a case.
//
// Run standalone: bun test test/proxy/refresh-window.test.ts
import { describe, expect, test } from "bun:test";

const { providers } = await import("../../src/proxy/providers/registry");

const H = 60 * 60 * 1000;
const D = 24 * H;

function jwt(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64({ exp: expSeconds })}.sig`;
}

/** Call the private needsRefresh() through the instance. */
function needs(tokens: any): boolean {
  const prov = providers["codebuddy-china"] as any;
  return prov.needsRefresh(tokens);
}

function jwtTokens(expOffsetMs: number | null, opts: Partial<{ refresh: boolean; access: boolean }> = {}) {
  const hasRefresh = opts.refresh ?? true;
  const hasAccess = opts.access ?? true;
  const exp = expOffsetMs === null ? null : Math.floor((Date.now() + expOffsetMs) / 1000);
  return {
    auth_method: "jwt",
    refresh_token: hasRefresh ? "refresh-abc" : undefined,
    access_token: hasAccess ? jwt(exp ?? Math.floor(Date.now() / 1000)) : undefined,
    uid: "uid-1",
    exp: exp,
  };
}

describe("refresh window decision", () => {
  test("refreshes when the token has already expired", () => {
    expect(needs(jwtTokens(-1 * H))).toBe(true);
    expect(needs(jwtTokens(-10 * D))).toBe(true);
  });

  test("refreshes inside the 3-day window", () => {
    expect(needs(jwtTokens(1 * H))).toBe(true);
    expect(needs(jwtTokens(1 * D))).toBe(true);
    expect(needs(jwtTokens(2 * D))).toBe(true);
    expect(needs(jwtTokens(2.9 * D))).toBe(true);
  });

  test("leaves a comfortable token alone", () => {
    expect(needs(jwtTokens(3.1 * D))).toBe(false);
    expect(needs(jwtTokens(12 * D))).toBe(false);
    expect(needs(jwtTokens(259 * D))).toBe(false);
  });

  test("refreshes when there is no access token at all", () => {
    expect(needs(jwtTokens(30 * D, { access: false }))).toBe(true);
  });

  test("refreshes when exp is missing and cannot be derived", () => {
    // No stored exp AND no JWT to derive it from → must not be assumed safe.
    const tokens = { auth_method: "jwt", refresh_token: "r", access_token: "not-a-jwt", uid: "u" };
    expect(needs(tokens)).toBe(true);
  });

  test("derives expiry from the JWT when the stored exp is absent", () => {
    const soon = Math.floor((Date.now() + 1 * D) / 1000);
    const far = Math.floor((Date.now() + 30 * D) / 1000);
    const base = { auth_method: "jwt", refresh_token: "r", uid: "u" };
    expect(needs({ ...base, access_token: jwt(soon) })).toBe(true);
    expect(needs({ ...base, access_token: jwt(far) })).toBe(false);
  });

  test("never refreshes accounts that cannot be refreshed", () => {
    // Static API key
    expect(needs({ auth_method: "api_key", api_key: "ck_x" })).toBe(false);
    // JWT without a refresh token — nothing to rotate with
    expect(needs(jwtTokens(-5 * D, { refresh: false }))).toBe(false);
    // No tokens at all
    expect(needs(null)).toBe(false);
    expect(needs(undefined)).toBe(false);
  });
});
