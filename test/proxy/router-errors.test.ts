import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import {
  assertUsingScratchDatabase,
  prepareScratchDatabase,
  removeDatabaseFiles,
} from "../scratch-db";

// Must run before any src/db import — DATABASE_PATH is read at db module load.
const scratch = prepareScratchDatabase("router-errors");

const { config } = await import("../../src/config");
const skipReason = assertUsingScratchDatabase(scratch, config.databasePath);

const { db } = await import("../../src/db/index");
const { accounts } = await import("../../src/db/schema");
const { eq } = await import("drizzle-orm");
const { encrypt } = await import("../../src/utils/crypto");
const { refreshByokModels } = await import("../../src/proxy/providers/registry");
const { routeRequest, AllAccountsFailedError } = await import("../../src/proxy/router");
const { proxyRouter } = await import("../../src/proxy/index");
type ChatCompletionRequest = import("../../src/proxy/providers/base").ChatCompletionRequest;

/**
 * Regression coverage for router error reporting.
 *
 * A BYOK prefix commonly holds a single key. The retry loop excludes each
 * attempted key, so attempt 2 finds no candidate — which used to throw
 * "No active accounts available for provider: byok" and discard the real
 * upstream failure from attempt 1, making an upstream outage look like a
 * missing-account or misconfigured-model problem.
 *
 * These tests write to the accounts table, so they only run when they have an
 * isolated database (see test/scratch-db.ts). Run this file on its own:
 *   bun test test/proxy/router-errors.test.ts
 */
describe.skipIf(skipReason !== null)(`routeRequest error reporting`, () => {
  let upstream: ReturnType<typeof Bun.serve> | null = null;

  async function seedByokAccount(baseUrl: string) {
    await db.insert(accounts).values({
      provider: "byok",
      email: "routertest#default",
      password: encrypt("test-key"),
      status: "active",
      enabled: true,
      tokens: JSON.stringify({
        base_url: baseUrl,
        format: "openai",
        models: ["some-model"],
        model_prefix: "routertest",
      }),
    });
    await refreshByokModels();
  }

  const request = () =>
    ({
      model: "routertest-some-model",
      messages: [{ role: "user", content: "hi" }],
    }) as ChatCompletionRequest;

  beforeEach(async () => {
    await db.delete(accounts);
    await refreshByokModels();
  });

  afterEach(async () => {
    upstream?.stop(true);
    upstream = null;
    await db.delete(accounts);
    await refreshByokModels();
  });

  afterAll(() => {
    if (scratch.path) removeDatabaseFiles(scratch.path);
  });

  it("surfaces the upstream error instead of 'no active accounts' for a single-key prefix", async () => {
    upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("<!DOCTYPE html>upstream is down", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
    });
    await seedByokAccount(`http://localhost:${upstream.port}/v1`);

    let caught: unknown;
    try {
      await routeRequest(request(), false);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AllAccountsFailedError);
    const error = caught as InstanceType<typeof AllAccountsFailedError>;
    expect(error.message).not.toContain("No active accounts available");
    expect(error.message).toContain("Upstream error");
    expect(error.upstreamError).toContain("502");
    expect(error.upstreamStatus).toBe(502);
    expect(error.provider).toBe("byok");
    expect(error.attempts).toBe(1);
    expect(error.lastAccountEmail).toBe("routertest#default");
  });

  it("keeps the account active when the upstream 502s (transient, not the key's fault)", async () => {
    upstream = Bun.serve({
      port: 0,
      fetch: () => new Response("gateway down", { status: 502 }),
    });
    await seedByokAccount(`http://localhost:${upstream.port}/v1`);

    await routeRequest(request(), false).catch(() => {});

    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.provider, "byok"));
    expect(account?.status).toBe("active");
    expect(account?.errorMessage).toContain("502");
  });

  it("still reports a missing account when nothing was ever attempted", async () => {
    // qoder has no accounts in the scratch database, so the loop never gets a
    // candidate and the pool-level message is the correct one to surface.
    await expect(
      routeRequest(
        { model: "qd-Lite", messages: [{ role: "user", content: "hi" }] } as ChatCompletionRequest,
        false
      )
    ).rejects.toThrow(/No active accounts available for provider: qoder/);
  });

  describe("HTTP responses", () => {
    async function post(pathname: string, payload: unknown) {
      const response = await proxyRouter.request(pathname, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { response, body: (await response.json()) as any };
    }

    it("returns 502 with the upstream body on /v1/chat/completions", async () => {
      upstream = Bun.serve({
        port: 0,
        fetch: () => new Response("cloudflare: host unreachable", { status: 502 }),
      });
      await seedByokAccount(`http://localhost:${upstream.port}/v1`);

      const { response, body } = await post("/v1/chat/completions", {
        model: "routertest-some-model",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(response.status).toBe(502);
      expect(body.error.code).toBe("upstream_error");
      expect(body.error.message).toContain("cloudflare: host unreachable");
      expect(body.error.upstream).toMatchObject({
        provider: "byok",
        status: 502,
        attempts: 1,
        account: "routertest#default",
      });
    });

    it("propagates a 429 as a rate-limit error on /v1/chat/completions", async () => {
      upstream = Bun.serve({
        port: 0,
        fetch: () => new Response("slow down please", { status: 429 }),
      });
      await seedByokAccount(`http://localhost:${upstream.port}/v1`);

      const { response, body } = await post("/v1/chat/completions", {
        model: "routertest-some-model",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(response.status).toBe(429);
      expect(body.error.type).toBe("rate_limit_error");
      expect(body.error.message).toContain("slow down please");
      // BYOK's 429 branch returns the raw upstream body with no status prefix,
      // so the 429 mapping has to come from the provider's rateLimited flag.
      expect(body.error.upstream.rateLimited).toBe(true);
    });

    it("returns 502 with the upstream body on /v1/messages", async () => {
      upstream = Bun.serve({
        port: 0,
        fetch: () => new Response("gateway exploded", { status: 503 }),
      });
      await seedByokAccount(`http://localhost:${upstream.port}/v1`);

      const { response, body } = await post("/v1/messages", {
        model: "routertest-some-model",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      });

      expect(response.status).toBe(502);
      expect(body.error.type).toBe("api_error");
      expect(body.error.message).toContain("gateway exploded");
      expect(body.error.upstream).toMatchObject({ provider: "byok", status: 503 });
    });
  });
});

if (skipReason) {
  console.warn(`[router-errors] skipped — ${skipReason}`);
}
