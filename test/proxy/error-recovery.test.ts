// Accounts parked in `error` must stay in rotation unless their credentials are
// dead. Run standalone (bun test test/proxy/error-recovery.test.ts).
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { prepareScratchDatabase, removeDatabaseFiles } from "../scratch-db";

const scratch = prepareScratchDatabase("error-recovery");
const { config } = await import("../../src/config");
const skipReason = config.databasePath.endsWith("error-recovery.db")
  ? null
  : `scratch DB not active (${config.databasePath}) — run this file on its own`;

const { db } = await import("../../src/db/index");
const { accounts } = await import("../../src/db/schema");
const { eq } = await import("drizzle-orm");
const { encrypt } = await import("../../src/utils/crypto");
const { pool } = await import("../../src/proxy/pool");
const { routeRequest } = await import("../../src/proxy/router");
const { providers } = await import("../../src/proxy/providers/registry");
const { ensureCbcModelsTable } = await import("../../src/db/migrate");
if (!skipReason) ensureCbcModelsTable();

async function seed(status: string, errorMessage: string | null = null) {
  const [row] = await db
    .insert(accounts)
    .values({
      provider: "codebuddy-china",
      email: `recover-${status}-${Math.random().toString(36).slice(2, 8)}`,
      password: encrypt("ck_test"),
      status,
      enabled: true,
      errorMessage,
      tokens: JSON.stringify({ api_key: "ck_test", auth_method: "api_key" }),
    })
    .returning();
  return row!;
}

async function statusOf(id: number) {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
  return { status: row?.status, errorMessage: row?.errorMessage };
}

afterAll(() => {
  if (scratch.path) removeDatabaseFiles(scratch.path);
});

describe.skipIf(skipReason !== null)("error-account recovery", () => {
  beforeEach(async () => {
    await db.delete(accounts);
    pool.invalidate("codebuddy-china");
  });

  test("an account in error with a transient failure stays in rotation", async () => {
    const a = await seed("error", "HTTP 502: bad gateway");
    pool.invalidate("codebuddy-china");
    const picked = await pool.getNextAccount("codebuddy-china");
    expect(picked?.id).toBe(a.id);
  });

  test("an account in error with a dead session is excluded", async () => {
    await seed("error", "Session expired, re-login required");
    pool.invalidate("codebuddy-china");
    const picked = await pool.getNextAccount("codebuddy-china");
    expect(picked).toBeNull();
  });

  test("401/403 errors exclude the account even without the session wording", async () => {
    await seed("error", "CodeBuddy China API returned 401: unauthorized");
    pool.invalidate("codebuddy-china");
    expect(await pool.getNextAccount("codebuddy-china")).toBeNull();
  });

  test("both healthy and errored accounts participate in rotation", async () => {
    const errored = await seed("error", "HTTP 502: bad gateway");
    const healthy = await seed("active");
    pool.invalidate("codebuddy-china");

    // Round-robin rotates across the eligible set, so both must eventually be
    // picked — an errored account is a full participant, not a last resort.
    const seen = new Set<number>();
    for (let i = 0; i < 6; i++) {
      const picked = await pool.getNextAccount("codebuddy-china");
      if (picked) seen.add(picked.id);
    }
    expect(seen.has(healthy.id)).toBe(true);
    expect(seen.has(errored.id)).toBe(true);
  });

  test("a successful request flips an errored account back to active and clears the error", async () => {
    const a = await seed("error", "HTTP 502: bad gateway");
    pool.invalidate("codebuddy-china");

    const prov = providers["codebuddy-china"] as any;
    const original = prov.chatCompletion.bind(prov);
    prov.chatCompletion = async () => ({
      success: true,
      response: {
        id: "x",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      promptTokens: 1,
      completionTokens: 1,
      tokensUsed: 2,
    });

    try {
      await routeRequest(
        { model: "cbc-glm-5.3", messages: [{ role: "user", content: "hi" }] } as any,
        false
      );
    } finally {
      prov.chatCompletion = original;
    }

    const after = await statusOf(a.id);
    expect(after.status).toBe("active");
    // The stale error text must be cleared so the dashboard stops flagging it.
    expect(after.errorMessage).toBeNull();
  });
});
