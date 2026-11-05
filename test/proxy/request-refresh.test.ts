// A busy account that never passes through warmup must still be refreshed
// before its token dies. Verifies the REQUEST path (chatCompletion /
// chatCompletionStream) rotates and persists inside the 3-day window.
//
// Run standalone: bun test test/proxy/request-refresh.test.ts
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { prepareScratchDatabase, removeDatabaseFiles } from "../scratch-db";

const scratch = prepareScratchDatabase("request-refresh");
const { config } = await import("../../src/config");
const skipReason = config.databasePath.endsWith("request-refresh.db")
  ? null
  : `scratch DB not active (${config.databasePath}) — run this file on its own`;

const { db } = await import("../../src/db/index");
const { accounts } = await import("../../src/db/schema");
const { eq } = await import("drizzle-orm");
const { encrypt } = await import("../../src/utils/crypto");
const { providers } = await import("../../src/proxy/providers/registry");
const { ensureCbcModelsTable } = await import("../../src/db/migrate");
if (!skipReason) ensureCbcModelsTable();

const D = 24 * 60 * 60 * 1000;

function jwt(expSeconds: number, tag = "a"): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", tag })}.${b64({ exp: expSeconds })}.sig`;
}

async function seed(expOffsetMs: number) {
  const exp = Math.floor((Date.now() + expOffsetMs) / 1000);
  const [row] = await db
    .insert(accounts)
    .values({
      provider: "codebuddy-china",
      email: `req-${Math.random().toString(36).slice(2, 8)}`,
      password: encrypt("x"),
      status: "active",
      enabled: true,
      tokens: JSON.stringify({
        auth_method: "jwt",
        access_token: jwt(exp, "old"),
        refresh_token: "old-refresh",
        uid: "uid-1",
        exp,
      }),
    })
    .returning();
  return row!;
}

async function tokensOf(id: number) {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
  const t = row!.tokens;
  return typeof t === "string" ? JSON.parse(t) : (t as any);
}

/** Stub the network: refresh succeeds, chat returns a minimal completion. */
function stub(prov: any, newExp: number) {
  const origRefresh = prov.refreshToken.bind(prov);
  const origMake = prov.makeRequest.bind(prov);
  const origAgg = prov.aggregateStreamResponse.bind(prov);
  let refreshCalls = 0;

  prov.refreshToken = async () => {
    refreshCalls++;
    return {
      success: true,
      tokens: JSON.stringify({
        auth_method: "jwt",
        access_token: jwt(newExp, "new"),
        refresh_token: "rotated-refresh",
        uid: "uid-1",
        exp: newExp,
      }),
    };
  };
  prov.makeRequest = async () => new Response("data: {}\n\n", { status: 200 });
  prov.aggregateStreamResponse = async () => ({
    id: "x",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

  return {
    get refreshCalls() { return refreshCalls; },
    restore() {
      prov.refreshToken = origRefresh;
      prov.makeRequest = origMake;
      prov.aggregateStreamResponse = origAgg;
    },
  };
}

afterAll(() => {
  if (scratch.path) removeDatabaseFiles(scratch.path);
});

describe.skipIf(skipReason !== null)("request-path auto refresh", () => {
  beforeEach(async () => { await db.delete(accounts); });

  test("chatCompletion refreshes an expiring token before sending", async () => {
    const account = await seed(2 * D); // inside the 3-day window
    const prov = providers["codebuddy-china"] as any;
    const newExp = Math.floor(Date.now() / 1000) + 30 * D;
    const s = stub(prov, newExp);

    try {
      await prov.chatCompletion(account, { model: "cbc-glm-5.3", messages: [{ role: "user", content: "hi" }] });
      expect(s.refreshCalls).toBe(1);

      const t = await tokensOf(account.id);
      expect(t.exp).toBe(newExp);
      // The rotated refresh token must be persisted — the old one is dead.
      expect(t.refresh_token).toBe("rotated-refresh");
    } finally {
      s.restore();
    }
  });

  test("chatCompletionStream refreshes an expired token before sending", async () => {
    const account = await seed(-1 * D); // already expired
    const prov = providers["codebuddy-china"] as any;
    const newExp = Math.floor(Date.now() / 1000) + 30 * D;
    const s = stub(prov, newExp);

    try {
      await prov.chatCompletionStream(account, { model: "cbc-glm-5.3", messages: [{ role: "user", content: "hi" }] });
      expect(s.refreshCalls).toBe(1);
      const t = await tokensOf(account.id);
      expect(t.exp).toBe(newExp);
    } finally {
      s.restore();
    }
  });

  test("does NOT rotate a token with plenty of life", async () => {
    const account = await seed(20 * D);
    const prov = providers["codebuddy-china"] as any;
    const s = stub(prov, Math.floor(Date.now() / 1000) + 40 * D);

    try {
      await prov.chatCompletion(account, { model: "cbc-glm-5.3", messages: [{ role: "user", content: "hi" }] });
      expect(s.refreshCalls).toBe(0);
      const t = await tokensOf(account.id);
      expect(t.refresh_token).toBe("old-refresh");
    } finally {
      s.restore();
    }
  });

  test("a failed refresh does not block the request or corrupt tokens", async () => {
    const account = await seed(1 * D);
    const prov = providers["codebuddy-china"] as any;
    const origRefresh = prov.refreshToken.bind(prov);
    const origMake = prov.makeRequest.bind(prov);
    const origAgg = prov.aggregateStreamResponse.bind(prov);

    prov.refreshToken = async () => ({ success: false, error: "invalid_grant: Offline user session not found" });
    prov.makeRequest = async () => new Response("data: {}\n\n", { status: 200 });
    prov.aggregateStreamResponse = async () => ({
      id: "x", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    try {
      const result = await prov.chatCompletion(account, { model: "cbc-glm-5.3", messages: [{ role: "user", content: "hi" }] });
      expect(result.success).toBe(true);

      // Stored tokens untouched — a failed refresh writes nothing.
      const t = await tokensOf(account.id);
      expect(t.refresh_token).toBe("old-refresh");
    } finally {
      prov.refreshToken = origRefresh;
      prov.makeRequest = origMake;
      prov.aggregateStreamResponse = origAgg;
    }
  });
});
