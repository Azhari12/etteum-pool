// Daily check-in (manual claim) for codebuddy-china.
// Run standalone: bun test test/proxy/checkin.test.ts
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { prepareScratchDatabase, removeDatabaseFiles } from "../scratch-db";

const scratch = prepareScratchDatabase("checkin");
const { config } = await import("../../src/config");
const skipReason = config.databasePath.endsWith("checkin.db")
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

async function seedCbc(metadata: unknown = null) {
  const [row] = await db
    .insert(accounts)
    .values({
      provider: "codebuddy-china",
      email: `checkin-${Math.random().toString(36).slice(2, 8)}`,
      password: encrypt("x"),
      status: "active",
      enabled: true,
      metadata: metadata as any,
      tokens: JSON.stringify({ api_key: "ck_test", auth_method: "api_key" }),
    })
    .returning();
  return row!;
}

async function seedOther() {
  const [row] = await db
    .insert(accounts)
    .values({
      provider: "kiro",
      email: `kiro-${Math.random().toString(36).slice(2, 8)}`,
      password: encrypt("x"),
      status: "active",
      enabled: true,
      tokens: null,
    })
    .returning();
  return row!;
}

function stubCheckin(impl: (a: any) => Promise<any>) {
  const prov = providers["codebuddy-china"] as any;
  const original = prov.dailyCheckin.bind(prov);
  prov.dailyCheckin = impl;
  return () => { prov.dailyCheckin = original; };
}

afterAll(() => {
  if (scratch.path) removeDatabaseFiles(scratch.path);
});

describe.skipIf(skipReason !== null)("daily check-in API", () => {
  beforeEach(async () => { await db.delete(accounts); });

  test("a successful claim reports credit + streak and stamps metadata", async () => {
    const account = await seedCbc();
    const restore = stubCheckin(async () => ({ success: true, claimed: true, credit: 100, streakDays: 11 }));

    try {
      const res = await accountsRouter.request(`/${account.id}/daily-checkin`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.claimed).toBe(true);
      expect(body.credit).toBe(100);
      expect(body.streakDays).toBe(11);

      const [after] = await db.select().from(accounts).where(eq(accounts.id, account.id));
      const meta = (after!.metadata ?? {}) as any;
      expect(typeof meta.lastCheckinAt).toBe("string");
      expect(meta.checkinStreakDays).toBe(11);
      expect(meta.lastCheckinCredit).toBe(100);
    } finally {
      restore();
    }
  });

  test("an 'already checked in today' reply is a 200, not an error", async () => {
    const account = await seedCbc();
    const restore = stubCheckin(async () => ({
      success: true,
      claimed: false,
      error: "今天已签到，请明天再来",
    }));

    try {
      const res = await accountsRouter.request(`/${account.id}/daily-checkin`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.claimed).toBe(false);
      expect(body.message).toContain("已签到");
    } finally {
      restore();
    }
  });

  test("a failed claim surfaces an error and does not stamp", async () => {
    const account = await seedCbc();
    const restore = stubCheckin(async () => ({ success: false, error: "Check-in failed: code 500" }));

    try {
      const res = await accountsRouter.request(`/${account.id}/daily-checkin`, { method: "POST" });
      expect(res.status).toBe(502);

      const [after] = await db.select().from(accounts).where(eq(accounts.id, account.id));
      expect((after!.metadata as any)?.lastCheckinAt).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("a session-expired claim maps to 400, not 502", async () => {
    const account = await seedCbc();
    const restore = stubCheckin(async () => ({ success: false, error: "Session expired, re-login required" }));

    try {
      const res = await accountsRouter.request(`/${account.id}/daily-checkin`, { method: "POST" });
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });

  test("rejects non-codebuddy-china accounts", async () => {
    const kiro = await seedOther();
    const res = await accountsRouter.request(`/${kiro.id}/daily-checkin`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(String(body.error)).toContain("codebuddy-china");
  });

  test("404 for an unknown account", async () => {
    const res = await accountsRouter.request("/999999/daily-checkin", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("checkin-status lists accounts stamped today (and is not shadowed by /:id)", async () => {
    const claimed = await seedCbc({ lastCheckinAt: new Date().toISOString() });
    const notClaimed = await seedCbc();
    // Stamped yesterday — must not count as today.
    const stale = await seedCbc({ lastCheckinAt: new Date(Date.now() - 2 * 86400000).toISOString() });

    const res = await accountsRouter.request("/checkin-status", { method: "GET" });
    // The route must resolve to checkin-status, not to GET /:id (which would 404).
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.claimedAccountIds).toContain(claimed.id);
    expect(body.claimedAccountIds).not.toContain(notClaimed.id);
    expect(body.claimedAccountIds).not.toContain(stale.id);
  });
});
