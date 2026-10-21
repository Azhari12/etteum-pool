import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Cpu, Copy, Check, Search, Plus, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  fetchModels,
  fetchCbcModels,
  createCbcModel,
  updateCbcModel,
  deleteCbcModel,
  type CbcModelDTO,
} from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { useWsEvent } from "@/hooks/useWebSocket";

interface ModelData {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  context_window?: number;
  max_output?: number;
  thinking?: boolean;
}

const providerColors: Record<string, string> = {
  kiro: "bg-[var(--chart-2)]/15 text-[var(--chart-2)] border-[var(--chart-2)]/30",
  "kiro-pro": "bg-[var(--primary)]/15 text-[var(--primary)] border-[var(--primary)]/30",
  codebuddy: "bg-[var(--chart-3)]/15 text-[var(--chart-3)] border-[var(--chart-3)]/30",
  "codebuddy-china": "bg-red-500/15 text-red-400 border-red-400/30",
  canva: "bg-[var(--chart-6)]/15 text-[var(--chart-6)] border-[var(--chart-6)]/30",
  codex: "bg-[var(--chart-1)]/15 text-[var(--chart-1)] border-[var(--chart-1)]/30",
  qoder: "bg-[var(--chart-4)]/15 text-[var(--chart-4)] border-[var(--chart-4)]/30",
};

function formatNumber(n: number | undefined): string {
  if (!n) return "-";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

export default function Models() {
  const [models, setModels] = useState<ModelData[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const { message: copiedModel, setMessage: setCopiedModel } = useTimedMessage<string>(null, 1500);

  useEffect(() => {
    fetchModels()
      .then((res: { data: ModelData[] }) => {
        setModels(res.data || []);
      })
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
  }, []);

  const providers = ["all", ...Array.from(new Set(models.map((m) => m.owned_by)))];

  const filtered = models
    .filter((m) => filter === "all" || m.owned_by === filter)
    .filter((m) =>
      search === "" ||
      m.id.toLowerCase().includes(search.toLowerCase()) ||
      m.owned_by.toLowerCase().includes(search.toLowerCase())
    );

  async function copyModelId(modelId: string) {
    await navigator.clipboard.writeText(modelId);
    setCopiedModel(modelId);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--primary)]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">Models</h1>
        <p className="text-sm text-[var(--muted-foreground)] mt-1">
          {models.length} models available across {new Set(models.map((m) => m.owned_by)).size} providers
        </p>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="p-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
            <input
              type="text"
              placeholder="Search models, owners..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
            />
          </div>
        </CardContent>
      </Card>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {providers.map((p) => (
          <button
            key={p}
            onClick={() => setFilter(p)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              filter === p
                ? "bg-[var(--info)]/20 text-[var(--info)] border border-[var(--info)]/30"
                : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            }`}
          >
            {p === "all" ? "All" : p.charAt(0).toUpperCase() + p.slice(1)}
          </button>
        ))}
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--secondary)]/50">
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
                    Model
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
                    Owner
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
                    Context
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
                    Output
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
                    Features
                  </th>
                  <th className="w-12"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((model) => (
                  <tr
                    key={model.id}
                    className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--secondary)]/30 transition-colors"
                  >
                    {/* Model ID */}
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[var(--foreground)]">
                          {model.id}
                        </span>
                      </div>
                    </td>

                    {/* Owner */}
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${providerColors[model.owned_by] || "bg-[var(--muted)]/20 text-[var(--muted-foreground)]"}`}>
                        {model.owned_by}
                      </span>
                    </td>

                    {/* Context */}
                    <td className="py-3 px-4 text-sm text-[var(--foreground)]">
                      {formatNumber(model.context_window)}
                    </td>

                    {/* Output */}
                    <td className="py-3 px-4 text-sm text-[var(--foreground)]">
                      {formatNumber(model.max_output)}
                    </td>

                    {/* Features */}
                    <td className="py-3 px-4">
                      {model.thinking && (
                        <Badge variant="default" className="text-xs">
                          Thinking
                        </Badge>
                      )}
                    </td>

                    {/* Copy Button */}
                    <td className="py-3 px-4">
                      <button
                        type="button"
                        onClick={() => copyModelId(model.id)}
                        title={`Copy model ID: ${model.id}`}
                        className="p-1.5 rounded-md hover:bg-[var(--secondary)] transition-colors group"
                      >
                        {copiedModel === model.id ? (
                          <Check className="w-4 h-4 text-[var(--success)]" />
                        ) : (
                          <Copy className="w-4 h-4 text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]" />
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12">
              <Cpu className="w-12 h-12 text-[var(--muted-foreground)] mb-4" />
              <p className="text-[var(--muted-foreground)]">No models found</p>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">
                Try adjusting your search or filter
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <CbcModelManager />
    </div>
  );
}

// ─── codebuddy-china dynamic model manager ───────────────────────────────
const EMPTY_FORM: CbcModelDTO = {
  modelId: "",
  upstreamModel: "",
  label: "",
  contextWindow: 200000,
  maxOutput: 8192,
  thinking: false,
  vision: false,
  creditUnit: "credit",
  creditRate: 0.01,
  creditSource: "upstream",
  enabled: true,
};

function CbcModelManager() {
  const [dynamic, setDynamic] = useState<CbcModelDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CbcModelDTO | null>(null);
  const [form, setForm] = useState<CbcModelDTO>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { message: saved, setMessage: setSaved } = useTimedMessage<string>(null, 2000);

  async function load() {
    try {
      const res = await fetchCbcModels();
      setDynamic(res.data || []);
    } catch {
      setDynamic([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);
  useWsEvent(["models_updated"], load);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setError(null);
    setDialogOpen(true);
  }

  function openEdit(model: CbcModelDTO) {
    setEditing(model);
    setForm({ ...EMPTY_FORM, ...model });
    setError(null);
    setDialogOpen(true);
  }

  async function save() {
    if (!form.modelId?.startsWith("cbc-")) { setError("Model ID must start with 'cbc-'"); return; }
    if (!form.upstreamModel?.trim()) { setError("Upstream model is required"); return; }
    setSaving(true);
    setError(null);
    try {
      if (editing?.id) {
        await updateCbcModel(editing.id, form);
        setSaved("Updated");
      } else {
        await createCbcModel(form);
        setSaved("Created");
      }
      setDialogOpen(false);
      void load();
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number, modelId: string) {
    if (!confirm(`Delete model "${modelId}"?`)) return;
    try {
      await deleteCbcModel(id);
      void load();
    } catch (e: any) {
      setError(e?.message || "Delete failed");
    }
  }

  function setField<K extends keyof CbcModelDTO>(key: K, value: CbcModelDTO[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">codebuddy-china — dynamic models</CardTitle>
          <p className="text-xs text-[var(--muted-foreground)] mt-1">
            Add models here so they appear in the pool without editing code. Static models in the table above are always available.
          </p>
        </div>
        <Button size="sm" onClick={openCreate} className="gap-1.5">
          <Plus className="w-4 h-4" /> Add model
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="p-6 text-sm text-[var(--muted-foreground)]">Loading…</div>
        ) : dynamic.length === 0 ? (
          <div className="p-6 text-sm text-[var(--muted-foreground)]">
            No dynamic models yet. Click "Add model" to create one.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--secondary)]/50">
                  <th className="text-left py-2 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase">Model ID</th>
                  <th className="text-left py-2 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase">Upstream</th>
                  <th className="text-left py-2 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase">Context</th>
                  <th className="text-left py-2 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase">Rate</th>
                  <th className="text-left py-2 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase">Features</th>
                  <th className="w-20"></th>
                </tr>
              </thead>
              <tbody>
                {dynamic.map((m) => (
                  <tr key={m.id} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--secondary)]/30">
                    <td className="py-2 px-4 text-sm font-medium text-[var(--foreground)]">{m.modelId}</td>
                    <td className="py-2 px-4 text-sm text-[var(--muted-foreground)] font-mono">{m.upstreamModel}</td>
                    <td className="py-2 px-4 text-sm text-[var(--foreground)]">{formatNumber(m.contextWindow)}</td>
                    <td className="py-2 px-4 text-sm text-[var(--foreground)]">{m.creditRate}</td>
                    <td className="py-2 px-4">
                      {m.thinking && <Badge variant="default" className="text-xs mr-1">Thinking</Badge>}
                      {m.vision && <Badge variant="secondary" className="text-xs">Vision</Badge>}
                    </td>
                    <td className="py-2 px-4">
                      <div className="flex gap-1">
                        <button onClick={() => openEdit(m)} className="p-1.5 rounded-md hover:bg-[var(--secondary)]" title="Edit">
                          <Pencil className="w-3.5 h-3.5 text-[var(--muted-foreground)]" />
                        </button>
                        <button onClick={() => remove(m.id!, m.modelId)} className="p-1.5 rounded-md hover:bg-[var(--secondary)]" title="Delete">
                          <Trash2 className="w-3.5 h-3.5 text-red-400" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {saved && <div className="px-4 py-2 text-xs text-[var(--success)]">{saved} ✓</div>}

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editing ? "Edit model" : "Add model"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 max-h-[60vh] overflow-y-auto py-2">
              <Field label="Model ID (pool-facing)" hint="Must start with cbc-">
                <input value={form.modelId} onChange={(e) => setField("modelId", e.target.value)} className={inputCls} placeholder="cbc-glm-5.3" />
              </Field>
              <Field label="Upstream model" hint="Sent to codebuddy.cn">
                <input value={form.upstreamModel} onChange={(e) => setField("upstreamModel", e.target.value)} className={inputCls} placeholder="glm-5.3" />
              </Field>
              <Field label="Label (optional)">
                <input value={form.label ?? ""} onChange={(e) => setField("label", e.target.value)} className={inputCls} placeholder="GLM 5.3" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Context window">
                  <input type="number" value={form.contextWindow} onChange={(e) => setField("contextWindow", Number(e.target.value))} className={inputCls} />
                </Field>
                <Field label="Max output">
                  <input type="number" value={form.maxOutput} onChange={(e) => setField("maxOutput", Number(e.target.value))} className={inputCls} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Credit rate">
                  <input type="number" step="0.001" value={form.creditRate} onChange={(e) => setField("creditRate", Number(e.target.value))} className={inputCls} />
                </Field>
                <Field label="Credit unit">
                  <select value={form.creditUnit} onChange={(e) => setField("creditUnit", e.target.value)} className={inputCls}>
                    <option value="credit">credit</option>
                    <option value="token">token</option>
                    <option value="request">request</option>
                    <option value="image">image</option>
                  </select>
                </Field>
              </div>
              <Field label="Credit source">
                <select value={form.creditSource} onChange={(e) => setField("creditSource", e.target.value)} className={inputCls}>
                  <option value="upstream">upstream</option>
                  <option value="quota_delta">quota_delta</option>
                  <option value="estimated">estimated</option>
                  <option value="fixed">fixed</option>
                </select>
              </Field>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={!!form.thinking} onChange={(e) => setField("thinking", e.target.checked)} />
                  Thinking
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={!!form.vision} onChange={(e) => setField("vision", e.target.checked)} />
                  Vision
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={!!form.enabled} onChange={(e) => setField("enabled", e.target.checked)} />
                  Enabled
                </label>
              </div>
              {error && <p className="text-sm text-red-400">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
              <Button onClick={save} disabled={saving}>{saving ? "Saving…" : editing ? "Save" : "Create"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

const inputCls = "w-full px-3 py-1.5 bg-[var(--background)] border border-[var(--border)] rounded-md text-sm text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-[var(--muted-foreground)] mb-1">{label}{hint && <span className="ml-1 opacity-70">({hint})</span>}</label>
      {children}
    </div>
  );
}
