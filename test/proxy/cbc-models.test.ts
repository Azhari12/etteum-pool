// End-to-end: create/list/update/delete cbc dynamic models via the HTTP API.
// Run standalone (bun test test/proxy/cbc-models.test.ts) so the scratch DB
// wins the race — see test/scratch-db.ts for why order matters.
import { describe, expect, test, afterAll } from "bun:test";
import { prepareScratchDatabase, removeDatabaseFiles } from "../scratch-db";

const scratch = prepareScratchDatabase("cbc-models");

const { config } = await import("../../src/config");
const skipReason =
  config.databasePath.endsWith("cbc-models.db")
    ? null
    : `scratch DB not active (db at ${config.databasePath}) — run this file on its own`;

const { modelsRouter } = await import("../../src/api/models");
const { refreshCbcModels } = await import("../../src/proxy/providers/registry");
const { ensureCbcModelsTable } = await import("../../src/db/migrate");

if (!skipReason) {
  ensureCbcModelsTable();
  await refreshCbcModels();
}

async function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await modelsRouter.request(path, init);
  return { status: res.status, body: (await res.json()) as any };
}

afterAll(() => {
  if (scratch.path) removeDatabaseFiles(scratch.path);
});

describe.skipIf(skipReason !== null)("CBC dynamic model API", () => {
  test("create → list → update → delete cycle", async () => {
    const created = await call("POST", "/cbc", { modelId: "cbc-glm-99", upstreamModel: "glm-99", vision: true, creditRate: 0.05 });
    expect(created.status).toBe(201);
    expect(created.body.data.modelId).toBe("cbc-glm-99");

    const list = await call("GET", "/cbc");
    expect(list.status).toBe(200);
    expect(list.body.data.some((m: any) => m.modelId === "cbc-glm-99")).toBe(true);

    const id = list.body.data.find((m: any) => m.modelId === "cbc-glm-99").id;
    const updated = await call("PUT", `/cbc/${id}`, { creditRate: 0.02, vision: false });
    expect(updated.status).toBe(200);
    expect(updated.body.data.creditRate).toBe(0.02);
    expect(updated.body.data.vision).toBe(false);

    const deleted = await call("DELETE", `/cbc/${id}`);
    expect(deleted.status).toBe(200);

    const gone = await call("DELETE", `/cbc/${id}`);
    expect(gone.status).toBe(404);
  });

  test("rejects modelId without cbc- prefix", async () => {
    const r = await call("POST", "/cbc", { modelId: "bad-prefix", upstreamModel: "x" });
    expect(r.status).toBe(400);
  });

  test("rejects duplicate modelId", async () => {
    await call("POST", "/cbc", { modelId: "cbc-dup", upstreamModel: "dup" });
    const r = await call("POST", "/cbc", { modelId: "cbc-dup", upstreamModel: "x" });
    expect(r.status).toBe(409);
  });

  test("dynamic model appears in provider catalog after refresh", async () => {
    await call("POST", "/cbc", { modelId: "cbc-catalog-check", upstreamModel: "catalog-check" });
    await refreshCbcModels();
    const { providers, getProviderForModel } = await import("../../src/proxy/providers/registry");
    const prov = providers["codebuddy-china"];
    expect(prov.ownsModel("cbc-catalog-check")).toBe(true);
    expect(getProviderForModel("cbc-catalog-check")).toBe("codebuddy-china");
    expect(prov.getModelInfo("cbc-catalog-check")?.id).toBe("cbc-catalog-check");
  });
});

if (skipReason) {
  console.warn(`[cbc-models] skipped — ${skipReason}`);
}
