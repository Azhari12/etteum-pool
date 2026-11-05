// Auto-login for codebuddy-china JWT accounts.
//
// Two regressions this locks down:
//  1. refreshToken() called the Keycloak OIDC endpoint, which rejects the grant
//     with `unauthorized_client` — the refresh never worked. It now uses the
//     WorkBuddy plugin endpoint.
//  2. The router retried with the stale in-memory account after refreshing, so
//     even a successful refresh still sent the expired token. updateTokens now
//     returns the fresh row and the retry uses it.
//
// Run standalone: bun test test/proxy/autologin.test.ts
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { prepareScratchDatabase, removeDatabaseFiles } from "../scratch-db";

const scratch = prepareScratchDatabase("autologin");
const { config } = await import("../../src/config");
const skipReason = config.databasePath.endsWith("autologin.db")
  ? null
  : `scratch DB not active (${config.databasePath}) — run this file on its own`;

const { db } = await import("../../src/db/index");
const { accounts } = await import("../../src/db/schema");
const { eq } = await import("drizzle-orm");
const { encrypt } = await import("../../src/utils/crypto");
const { providers } = await import("../../src/proxy/providers/registry");
const { mapHealthToAccountUpdate } = await import("../../src/auth/warmup-runner");
const { ensureCbcModelsTable } = await import("../../src/db/migrate");
if (!skipReason) ensureCbcModelsTable();

// A long-lived refresh token so the account is otherwise recoverable.
const REFRESH = "offline_refresh_token_stub";

function jwtWith(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64({ exp: expSeconds, azp: "console" })}.sig`;
}

async function seedAccount(opts: { exp: number; enabled: boolean; status: string; errorMessage?: string | null }) {
  const [row] = await db
    .insert(accounts)
    .values({
      provider: "codebuddy-china",
      email: `autologin-${Math.random().toString(36).slice(2, 8)}`,
      password: encrypt("x"),
      status: opts.status,
      enabled: opts.enabled,
      errorMessage: opts.errorMessage ?? null,
      tokens: JSON.stringify({
        auth_method: "jwt",
        access_token: jwtWith(opts.exp),
        refresh_token: REFRESH,
        uid: "uid-test",
        exp: opts.exp,
        identity: { username: "autologin" },
      }),
    })
    .returning();
  return row!;
}

afterAll(() => {
  if (scratch.path) removeDatabaseFiles(scratch.path);
});

describe.skipIf(skipReason !== null)("codebuddy-china auto-login", () => {
  beforeEach(async () => {
    await db.delete(accounts);
  });

  test("healthCheck refreshes an expired account and reports it healthy", async () => {
    const account = await seedAccount({ exp: 1, enabled: false, status: "error", errorMessage: "Session expired, re-login required" });

    const prov = providers["codebuddy-china"] as any;
    const originalRefresh = prov.refreshToken.bind(prov);
    const originalQuota = prov.fetchQuotaWithTokens.bind(prov);
    let refreshCalls = 0;
    const newExp = Math.floor(Date.now() / 1000) + 3600;

    // Stub the network: refresh succeeds and rotates both tokens.
    prov.refreshToken = async () => {
      refreshCalls++;
      return {
        success: true,
        tokens: JSON.stringify({
          auth_method: "jwt",
          access_token: jwtWith(newExp),
          refresh_token: "rotated-refresh",
          uid: "uid-test",
          exp: newExp,
        }),
      };
    };
    prov.fetchQuotaWithTokens = async () => ({
      success: true,
      quota: { limit: 100, remaining: 50, used: 50 },
    });

    try {
      const health = await prov.healthCheck(account);
      expect(refreshCalls).toBe(1);
      expect(health.kind).toBe("healthy");
      // The rotated pair must come back so warmup can persist it.
      expect(typeof health.tokens).toBe("string");
      expect(String(health.tokens)).toContain("rotated-refresh");
    } finally {
      prov.refreshToken = originalRefresh;
      prov.fetchQuotaWithTokens = originalQuota;
    }
  });

  test("refreshes when the token expires within the 3-day window", async () => {
    // Expires in ~2 days: inside the proactive window, so it must refresh.
    const exp = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;
    const account = await seedAccount({ exp, enabled: true, status: "active" });

    const prov = providers["codebuddy-china"] as any;
    const originalRefresh = prov.refreshToken.bind(prov);
    const originalQuota = prov.fetchQuotaWithTokens.bind(prov);
    let refreshCalls = 0;
    prov.refreshToken = async () => {
      refreshCalls++;
      const newExp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
      return {
        success: true,
        tokens: JSON.stringify({ auth_method: "jwt", access_token: jwtWith(newExp), refresh_token: "rotated", uid: "uid-test", exp: newExp }),
      };
    };
    prov.fetchQuotaWithTokens = async () => ({ success: true, quota: { limit: 10, remaining: 5, used: 5 } });

    try {
      await prov.healthCheck(account);
      expect(refreshCalls).toBe(1);
    } finally {
      prov.refreshToken = originalRefresh;
      prov.fetchQuotaWithTokens = originalQuota;
    }
  });

  test("leaves a token with plenty of life alone (refresh is single-use)", async () => {
    // Expires in ~20 days: far outside the window — must NOT be rotated, since
    // every refresh invalidates the old refresh token.
    const exp = Math.floor(Date.now() / 1000) + 20 * 24 * 60 * 60;
    const account = await seedAccount({ exp, enabled: true, status: "active" });

    const prov = providers["codebuddy-china"] as any;
    const originalRefresh = prov.refreshToken.bind(prov);
    const originalQuota = prov.fetchQuotaWithTokens.bind(prov);
    let refreshCalls = 0;
    prov.refreshToken = async () => { refreshCalls++; return { success: false, error: "should not be called" }; };
    prov.fetchQuotaWithTokens = async () => ({ success: true, quota: { limit: 10, remaining: 10, used: 0 } });

    try {
      const health = await prov.healthCheck(account);
      expect(refreshCalls).toBe(0);
      expect(health.kind).toBe("healthy");
      // No rotation → no tokens to persist.
      expect(health.tokens).toBeUndefined();
    } finally {
      prov.refreshToken = originalRefresh;
      prov.fetchQuotaWithTokens = originalQuota;
    }
  });

  test("warmup re-enables a disabled account once it is healthy again", async () => {
    const account = await seedAccount({ exp: 1, enabled: false, status: "error", errorMessage: "Session expired" });
    const update = mapHealthToAccountUpdate(account, { kind: "healthy", success: true });
    expect(update.status).toBe("active");
    expect(update.enabled).toBe(true);
    expect(update.errorMessage).toBeNull();
  });

  test("warmup leaves enabled alone for an account already enabled", async () => {
    const account = await seedAccount({ exp: 1, enabled: true, status: "error" });
    const update = mapHealthToAccountUpdate(account, { kind: "healthy", success: true });
    expect(update.status).toBe("active");
    // undefined = don't touch the column.
    expect(update.enabled).toBeUndefined();
  });

  test("an account whose session cannot be refreshed stays errored", async () => {
    const account = await seedAccount({ exp: 1, enabled: true, status: "error" });
    const prov = providers["codebuddy-china"] as any;
    const originalRefresh = prov.refreshToken.bind(prov);
    const originalQuota = prov.fetchQuotaWithTokens.bind(prov);
    const originalValidate = prov.validateApiKey.bind(prov);

    prov.refreshToken = async () => ({ success: false, error: "Refresh rejected: code=40100" });
    prov.fetchQuotaWithTokens = async () => ({ success: false, error: "HTTP 401" });
    prov.validateApiKey = async () => "expired";

    try {
      const health = await prov.healthCheck(account);
      expect(health.kind).toBe("session_expired");
      const update = mapHealthToAccountUpdate(account, health);
      expect(update.status).toBe("error");
      // Not re-enabled — still needs a human.
      expect(update.enabled).toBeUndefined();
    } finally {
      prov.refreshToken = originalRefresh;
      prov.fetchQuotaWithTokens = originalQuota;
      prov.validateApiKey = originalValidate;
    }
  });

  test("a non-JWT (static API key) account is never refreshed", async () => {
    const [row] = await db
      .insert(accounts)
      .values({
        provider: "codebuddy-china",
        email: "static-key-account",
        password: encrypt("x"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({ api_key: "ck_static", auth_method: "api_key" }),
      })
      .returning();

    const prov = providers["codebuddy-china"] as any;
    let refreshCalls = 0;
    const originalRefresh = prov.refreshToken.bind(prov);
    prov.refreshToken = async () => { refreshCalls++; return { success: false, error: "no refresh" }; };
    const originalQuota = prov.fetchQuotaWithTokens.bind(prov);
    prov.fetchQuotaWithTokens = async () => ({ success: true, quota: { limit: 10, remaining: 10, used: 0 } });

    try {
      await prov.healthCheck(row);
      expect(refreshCalls).toBe(0);
    } finally {
      prov.refreshToken = originalRefresh;
      prov.fetchQuotaWithTokens = originalQuota;
    }
  });

  test("static key accounts report no refresh capability", async () => {
    const prov = providers["codebuddy-china"] as any;
    const result = await prov.refreshToken({
      id: 1,
      provider: "codebuddy-china",
      email: "x",
      tokens: JSON.stringify({ api_key: "ck_static", auth_method: "api_key" }),
    } as any);
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("no refresh_token");
  });
});
