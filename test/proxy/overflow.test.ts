// Verify a context-overflow response stops the retry loop at attempt 1 and
// leaves the account untouched. Standalone (bun test <file>).
import { describe, expect, test, afterAll } from "bun:test";
import { prepareScratchDatabase, removeDatabaseFiles } from "../scratch-db";

const scratch = prepareScratchDatabase("overflow");
const { config } = await import("../../src/config");
const skipReason = config.databasePath.endsWith("overflow.db")
  ? null
  : `scratch DB not active (${config.databasePath}) — run this file on its own`;

const { db } = await import("../../src/db/index");
const { accounts } = await import("../../src/db/schema");
const { eq } = await import("drizzle-orm");
const { encrypt } = await import("../../src/utils/crypto");
const { refreshByokModels } = await import("../../src/proxy/providers/registry");
const { routeRequest } = await import("../../src/proxy/router");
const { ensureCbcModelsTable } = await import("../../src/db/migrate");
if (!skipReason) ensureCbcModelsTable();

const OVERFLOW_BODY =
  '{"code":11115,"msg":"prompt is too long: 1049004 tokens > 1048576 maximum",' +
  '"extError":{"code":"invalid_request_error","type":"invalid_request_error","StatusCode":400}}';

afterAll(() => {
  if (scratch.path) removeDatabaseFiles(scratch.path);
});

describe.skipIf(skipReason !== null)("context overflow handling", () => {
  test("stops at attempt 1 and does not poison the account", async () => {
    // Seed three CBC accounts so the retry loop has something to retry with.
    for (const i of [1, 2, 3]) {
      await db.insert(accounts).values({
        provider: "codebuddy-china",
        email: `overflow-${i}`,
        password: encrypt("ck_test"),
        status: "active",
        enabled: true,
        tokens: JSON.stringify({ api_key: "ck_test", auth_method: "api_key" }),
      });
    }

    const { providers } = await import("../../src/proxy/providers/registry");
    const prov = providers["codebuddy-china"] as any;
    const origChat = prov.chatCompletion.bind(prov);
    const origStream = prov.chatCompletionStream.bind(prov);
    let attempts = 0;
    const fail = async () => {
      attempts++;
      return {
        success: false,
        error: `CodeBuddy China API error (400): ${OVERFLOW_BODY}`,
      };
    };
    prov.chatCompletion = fail;
    prov.chatCompletionStream = fail;

    let caught: unknown;
    try {
      await routeRequest(
        { model: "cbc-glm-5.3", messages: [{ role: "user", content: "x" }] } as any,
        false
      );
    } catch (e) {
      caught = e;
    }

    prov.chatCompletion = origChat;
    prov.chatCompletionStream = origStream;

    const message = (caught as Error)?.message ?? "";
    // The error is thrown from the loop (client error), not the pool-level
    // "All accounts failed ... after 3 attempts" message.
    expect(message).toContain("prompt is too long");
    expect(message).not.toContain("All accounts failed");
    expect(attempts).toBe(1);

    // Accounts stay active — a context overflow is not the key's fault.
    const rows = await db
      .select()
      .from(accounts)
      .where(eq(accounts.provider, "codebuddy-china"));
    expect(rows.every((r) => r.status === "active")).toBe(true);

    await db.delete(accounts);
    await refreshByokModels();
  });
});
