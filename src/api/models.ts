import { Hono } from "hono";
import { db } from "../db/index";
import { cbcModels, type CbcModel } from "../db/schema";
import { eq } from "drizzle-orm";
import { broadcast } from "../ws/index";
import { refreshCbcModels } from "../proxy/providers/registry";

export const modelsRouter = new Hono();

const VALID_CREDIT_UNITS = new Set(["token", "request", "image", "credit"]);
const VALID_CREDIT_SOURCES = new Set(["upstream", "quota_delta", "estimated", "fixed"]);

interface CbcModelDTO {
  id?: number;
  modelId: string;
  upstreamModel: string;
  label?: string | null;
  contextWindow?: number;
  maxOutput?: number;
  thinking?: boolean;
  vision?: boolean;
  creditUnit?: string;
  creditRate?: number;
  creditSource?: string;
  enabled?: boolean;
}

/**
 * Map a DB row to the DTO the dashboard expects. Static models (from the
 * provider code) are tagged separately — only DB rows come through this path.
 */
function toDTO(row: CbcModel): CbcModelDTO {
  return {
    id: row.id,
    modelId: row.modelId,
    upstreamModel: row.upstreamModel,
    label: row.label,
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutput,
    thinking: row.thinking,
    vision: row.vision,
    creditUnit: row.creditUnit,
    creditRate: row.creditRate,
    creditSource: row.creditSource,
    enabled: row.enabled,
  };
}

/**
 * GET /api/models/cbc — list all dynamic codebuddy-china models.
 */
modelsRouter.get("/cbc", async (c) => {
  const rows = await db.select().from(cbcModels).orderBy(cbcModels.id);
  return c.json({ data: rows.map(toDTO) });
});

function validateBody(body: Partial<CbcModelDTO>, { allowId }: { allowId: boolean }): string | null {
  if (!body.modelId || typeof body.modelId !== "string" || !body.modelId.startsWith("cbc-")) {
    return "modelId must start with 'cbc-'";
  }
  if (!body.upstreamModel || typeof body.upstreamModel !== "string" || !body.upstreamModel.trim()) {
    return "upstreamModel is required";
  }
  if (body.creditUnit && !VALID_CREDIT_UNITS.has(body.creditUnit)) {
    return `creditUnit must be one of: ${[...VALID_CREDIT_UNITS].join(", ")}`;
  }
  if (body.creditSource && !VALID_CREDIT_SOURCES.has(body.creditSource)) {
    return `creditSource must be one of: ${[...VALID_CREDIT_SOURCES].join(", ")}`;
  }
  if (body.contextWindow !== undefined && (!Number.isFinite(body.contextWindow) || body.contextWindow <= 0)) {
    return "contextWindow must be a positive number";
  }
  if (body.maxOutput !== undefined && (!Number.isFinite(body.maxOutput) || body.maxOutput <= 0)) {
    return "maxOutput must be a positive number";
  }
  if (body.creditRate !== undefined && (!Number.isFinite(body.creditRate) || body.creditRate < 0)) {
    return "creditRate must be >= 0";
  }
  if (allowId && body.id !== undefined) {
    return "id is not accepted in the body";
  }
  return null;
}

/**
 * POST /api/models/cbc — add a dynamic model.
 */
modelsRouter.post("/cbc", async (c) => {
  const body = await c.req.json<Partial<CbcModelDTO>>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);

  const err = validateBody(body, { allowId: true });
  if (err) return c.json({ error: err }, 400);

  // Uniqueness check on model_id.
  const existing = await db.select({ id: cbcModels.id }).from(cbcModels).where(eq(cbcModels.modelId, body.modelId!));
  if (existing.length > 0) return c.json({ error: `Model '${body.modelId}' already exists` }, 409);

  const inserted = await db.insert(cbcModels).values({
    modelId: body.modelId!,
    upstreamModel: body.upstreamModel!,
    label: body.label ?? null,
    contextWindow: body.contextWindow ?? 200000,
    maxOutput: body.maxOutput ?? 8192,
    thinking: body.thinking ?? false,
    vision: body.vision ?? false,
    creditUnit: body.creditUnit ?? "credit",
    creditRate: body.creditRate ?? 0.01,
    creditSource: body.creditSource ?? "upstream",
    enabled: body.enabled ?? true,
  }).returning();

  await refreshCbcModels();
  broadcast({ type: "models_updated", data: { provider: "codebuddy-china", modelId: body.modelId } });
  return c.json({ success: true, data: toDTO(inserted[0]!) }, 201);
});

/**
 * PUT /api/models/cbc/:id — update a dynamic model.
 */
modelsRouter.put("/cbc/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: "Invalid id" }, 400);

  const body = await c.req.json<Partial<CbcModelDTO>>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);

  // modelId / upstreamModel: if provided, must still pass the same rules.
  const err = validateBody(
    { modelId: body.modelId ?? "cbc-x", upstreamModel: body.upstreamModel ?? "x", ...body },
    { allowId: true },
  );
  if (err) return c.json({ error: err }, 400);

  const [existing] = await db.select().from(cbcModels).where(eq(cbcModels.id, id));
  if (!existing) return c.json({ error: "Model not found" }, 404);

  // If modelId is changing, check for collision.
  if (body.modelId && body.modelId !== existing.modelId) {
    const clash = await db.select({ id: cbcModels.id }).from(cbcModels).where(eq(cbcModels.modelId, body.modelId));
    if (clash.length > 0) return c.json({ error: `Model '${body.modelId}' already exists` }, 409);
  }

  const [updated] = await db.update(cbcModels).set({
    modelId: body.modelId ?? existing.modelId,
    upstreamModel: body.upstreamModel ?? existing.upstreamModel,
    label: body.label !== undefined ? body.label ?? null : existing.label,
    contextWindow: body.contextWindow ?? existing.contextWindow,
    maxOutput: body.maxOutput ?? existing.maxOutput,
    thinking: body.thinking ?? existing.thinking,
    vision: body.vision ?? existing.vision,
    creditUnit: body.creditUnit ?? existing.creditUnit,
    creditRate: body.creditRate ?? existing.creditRate,
    creditSource: body.creditSource ?? existing.creditSource,
    enabled: body.enabled ?? existing.enabled,
    updatedAt: new Date(),
  }).where(eq(cbcModels.id, id)).returning();

  await refreshCbcModels();
  broadcast({ type: "models_updated", data: { provider: "codebuddy-china", modelId: updated?.modelId } });
  return c.json({ success: true, data: updated ? toDTO(updated) : null });
});

/**
 * DELETE /api/models/cbc/:id — remove a dynamic model.
 */
modelsRouter.delete("/cbc/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: "Invalid id" }, 400);

  const [existing] = await db.select().from(cbcModels).where(eq(cbcModels.id, id));
  if (!existing) return c.json({ error: "Model not found" }, 404);

  await db.delete(cbcModels).where(eq(cbcModels.id, id));
  await refreshCbcModels();
  broadcast({ type: "models_updated", data: { provider: "codebuddy-china", modelId: existing.modelId, deleted: true } });
  return c.json({ success: true });
});
