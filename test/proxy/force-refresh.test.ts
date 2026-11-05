// POST /api/accounts/:id/refresh-token — the manual "force refresh" override.
// Run standalone: bun test test/proxy/force-refresh.test.ts
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { prepareScratchDatabase, removeDatabaseFiles } from "../scratch-db";

const scratch = prepareScratchDatabase("force-refresh");
const { config } = await import("../../src/config");
const skipReason = config.databasePath.endsWith("force-refresh.db")
  ? null
  : `scratch DB not active (${config.databasePath}) — run this file on its own`;

const { db } = await import("../../src/db/index");
const { accounts } = await import("../../src/db/schema");
const { eq } = await import("drizzle-orm");
const { encrypt } = await import("../../src/utils/crypto");
const { providers } = await import("../../src/proxy/providers/registry");
const { accountsRouter } = await import("../../src/api/accounts");
const { ensureCbcModelsTable } = await import("../../src/db/migrate");
if (!skipReason) ensureCbcModelsTable();

function jwtWith(expSeconds: number, tag = "a"): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", tag })}.${b64({ exp: expSeconds, azp: "console" })}.sig`;
}

async function seed(tokens: Record<string, unknown>) {
  const [row] = await db
    .insert(accounts)
    .values({
      provider: "codebuddy-china",
      email: `force-${Math.random().toString(36).slice(2, 8)}`,
      password: encrypt("x"),
      status: "active",
      enabled: true,
      tokens: JSON.stringify(tokens),
    })
    .returning();
  return row!;
}

function stubRefresh(impl: (account: any) => Promise<{ success: boolean; tokens?: string; error?: string }>) {
  const prov = providers["codebuddy-china"] as any;
  const original = prov.refreshToken.bind(prov);
  prov.refreshToken = impl;
  return () => { prov.refreshToken = original; };
}

afterAll(() => {
  if (scratch.path) removeDatabaseFiles(scratch.path);
});

describe.skipIf(skipReason !== null)("POST /api/accounts/:id/refresh-token", () => {
  beforeEach(async () => { await db.delete(accounts); });

  test("rotates and persists both tokens", async () => {
    const oldExp = Math.floor(Date.now() / 1000) + 86400;
    const account = await seed({
      auth_method: "jwt",
      access_token: jwtWith(oldExp, "old"),
      refresh_token: "old-refresh",
      uid: "uid-1",
      exp: oldExp,
    });

    const newExp = Math.floor(Date.now() / 1000) + 30 * 86400;
    const restore = stubRefresh(async () => ({
      success: true,
      tokens: JSON.stringify({
        auth_method: "jwt",
        access_token: jwtWith(newExp, "new"),
        refresh_token: "new-refresh",
        uid: "uid-1",
        exp: newExp,
      }),
    }));

    try {
      const res = await accountsRouter.request(`/${account.id}/refresh-token`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.exp).toBe(newExp);

      const [after] = await db.select().from(accounts).where(eq(accounts.id, account.id));
      const t = typeof after!.tokens === "string" ? JSON.parse(after!.tokens) : (after!.tokens as any);
      expect(t.exp).toBe(newExp);
      // The rotated refresh token MUST be stored — the old one is now dead.
      expect(t.refresh_token).toBe("new-refresh");
    } finally {
      restore();
    }
  });

  test("returns 400 when the provider cannot refresh (static API key)", async () => {
    const account = await seed({ api_key: "ck_static", auth_method: "api_key" });
    const res = await accountsRouter.request(`/${account.id}/refresh-token`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(String(body.error)).toContain("no refresh_token");
  });

  test("does not touch stored tokens when the refresh fails", async () => {
    const exp = Math.floor(Date.now() / 1000) + 86400;
    const original = {
      auth_method: "jwt",
      access_token: jwtWith(exp, "keep"),
      refresh_token: "keep-refresh",
      uid: "uid-1",
      exp,
    };
    const account = await seed(original);
    const restore = stubRefresh(async () => ({ success: false, error: "Refresh rejected: code=40100" }));

    try {
      const res = await accountsRouter.request(`/${account.id}/refresh-token`, { method: "POST" });
      expect(res.status).toBe(400);

      const [after] = await db.select().from(accounts).where(eq(accounts.id, account.id));
      const t = typeof after!.tokens === "string" ? JSON.parse(after!.tokens) : (after!.tokens as any);
      expect(t.refresh_token).toBe("keep-refresh");
      expect(t.exp).toBe(exp);
    } finally {
      restore();
    }
  });

  test("404 for an unknown account", async () => {
    const res = await accountsRouter.request("/999999/refresh-token", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("400 for an invalid id", async () => {
    const res = await accountsRouter.request("/abc/refresh-token", { method: "POST" });
    expect(res.status).toBe(400);
  });
});
