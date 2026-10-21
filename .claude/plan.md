# Plan — Fitur tambah model codebuddy-china tanpa coding

## Tujuan
Menambah/menghapus model codebuddy-china (`cbc-*`) dari dashboard, tanpa ubah kode provider. Saat ini menambah model butuh edit 3 tempat di `codebuddy-china.ts`: `CBC_MODEL_MAP`, `supportedModels`, dan (otomatis via prefix) `ownsModel`. Fitur ini memindahkan katalog model ke DB, dengan model statis di kode sebagai default yang selalu ada.

## Arsitektur

### 1. Tabel DB baru: `cbc_models` (schema + migration)
File: `src/db/schema.ts` + `src/db/migrate.ts`

```
cbc_models(
  id integer PRIMARY KEY,
  model_id text NOT NULL UNIQUE,        -- "cbc-glm-5.3" (pool-facing id, dengan prefix)
  upstream_model text NOT NULL,          -- "glm-5.3" (id yang dikirim ke codebuddy.cn)
  label text,                             -- "GLM 5.3" (opsional, untuk display)
  context_window integer DEFAULT 200000,
  max_output integer DEFAULT 8192,
  thinking integer DEFAULT 0,             -- boolean
  vision integer DEFAULT 0,              -- boolean
  credit_unit text DEFAULT 'credit',      -- 'token' | 'request' | 'image' | 'credit'
  credit_rate real DEFAULT 0.01,
  credit_source text DEFAULT 'upstream',  -- 'upstream' | 'quota_delta' | 'estimated' | 'fixed'
  enabled integer DEFAULT 1,
  created_at integer, updated_at integer
)
```

Migration idempotent pattern mengikuti `IDEMPOTENT_COLUMNS` di `migrate.ts`: `CREATE TABLE IF NOT EXISTS cbc_models (...)`. Tambah juga `ensureCbcModelsTable()` yang dipanggil dari `ensureModelMappingTable()` atau boot `src/index.ts`, sama seperti pola `model_mappings`.

### 2. Cache model dinamis di CodeBuddyChinaProvider
File: `src/proxy/providers/codebuddy-china.ts`

- Tambah field `private dynamicModels: ModelInfo[] = []` + `private dynamicMap: Map<string, string> = Map` (model_id → upstream_model).
- Tambah `async refreshModelsCache(): Promise<void>` — baca `cbc_models` dari DB, bangun `dynamicModels` + `dynamicMap`. Mengikuti pola `ByokProvider.refreshModelsCache()` dan `GitlabDuoProvider.refreshModelsCache()`.
- Override `getModels(): ModelInfo[]` — return `[...this.supportedModels, ...this.dynamicModels]` (static + dynamic, static duluan untuk resolve duplikat).
- Override `getModelInfo(model)` — cek dynamic dulu, lalu static. Atau cukup pakai union list (karena `getModelInfo` default sudah linear search di `supportedModels`, override untuk cari di union).
- Modifikasi `resolveModel()` — cek `this.dynamicMap` dulu, lalu fallback ke `CBC_MODEL_MAP` statis. Untuk model tanpa mapping eksplisit, fallback ke `model` apa adanya (prilaku saat ini).
- `ownsModel()` TIDAK perlu diubah — sudah pakai prefix `cbc-`, jadi model `cbc-*` apapun (statis/dinamis) otomatis di-own.

### 3. Registry: expose refresh untuk cbc
File: `src/proxy/providers/registry.ts`

- Export `refreshCbcModels()` (mirip `refreshByokModels`), panggil `codebuddyChina.refreshModelsCache()`.
- Boot `src/index.ts`: panggil `refreshCbcModels()` di startup (sama seperti `refreshByokModels()` + `refreshGitlabDuoModels()`), dan setelah CRUD model dari API.

### 4. API CRUD: `src/api/models.ts` (file baru) + mount di `src/api/index.ts`
Router Hono baru, di-mount sebagai `apiRouter.route("/models", modelsRouter)`.

Endpoint:
- `GET /api/models/cbc` — list semua model cbc (statis + dinamis, flag `source: "static" | "dynamic"`).
- `POST /api/models/cbc` — tambah model dynamic. Body: `{ model_id, upstream_model, label?, context_window?, max_output?, thinking?, vision?, credit_unit?, credit_rate?, credit_source? }`. Validasi: `model_id` harus start with `cbc-`, unik. Setelah insert: `refreshCbcModels()` + broadcast WS.
- `PUT /api/models/cbc/:id` — update field dinamis. Refresh + broadcast.
- `DELETE /api/models/cbc/:id` — hapus model dinamis (statis tidak bisa dihapus, return 400). Refresh + broadcast.

Broadcast `broadcast({ type: "models_updated" })` setelah setiap perubahan supaya dashboard realtime.

### 5. Dashboard: API lib + UI di Models.tsx
File: `dashboard/src/lib/api.ts` + `dashboard/src/pages/Models.tsx`

- `api.ts`: tambah `fetchCbcModels()`, `createCbcModel()`, `updateCbcModel()`, `deleteCbcModel()`, type `CbcModelDTO`.
- `Models.tsx`: tambah section/tab "Manage Models" (khusus codebuddy-china). UI:
  - Tabel/list model cbc dengan badge "static" (read-only) atau "dynamic" (editable/delete).
  - Tombol "Add Model" → dialog form: model_id (must start `cbc-`), upstream_model, label, context_window, max_output, thinking, vision, credit_rate, credit_unit, credit_source.
  - Edit/delete untuk model dynamic.
  - `useWsEvent(["models_updated"], reload)` untuk refresh otomatis.

## Validasi & keamanan
- `model_id` harus `startsWith("cbc-")` — kalau bukan, 400. Ini supaya routing prefix tetap konsisten.
- `upstream_model` required, non-empty.
- `credit_unit` / `credit_source` divalidasi terhadap union type `CreditUnit` / `CreditSource`.
- Model statis (dari kode) tidak bisa dihapus/edit dari API — flag `source: "static"` di response, endpoint delete/update 404/400 kalau id bukan dynamic.
- `refreshCbcModels()` dijalankan setelah setiap write, jadi cache selalu segar.

## Testing
- `test/proxy/cbc-models.test.ts` (baru, standalone pakai scratch-db):
  - Model dynamic masuk ke `getModels()` setelah `refreshModelsCache()`.
  - `resolveModel()` pakai dynamic map.
  - `ownsModel("cbc-baru")` return true.
  - CRUD API: create → muncul di GET, delete → hilang, update field berubah.
  - Statis model tidak bisa dihapus.
- Update CLAUDE.md: dokumentasikan tabel `cbc_models` + alur refresh, di section "Database" dan "BYOK/CBC".

## File yang diubah
1. `src/db/schema.ts` — tambah `cbcModels` table export.
2. `src/db/migrate.ts` — tambah `ensureCbcModelsTable()` + panggil di boot.
3. `src/proxy/providers/codebuddy-china.ts` — dynamic cache + `refreshModelsCache()` + override `getModels()`/`getModelInfo()` + modifikasi `resolveModel()`.
4. `src/proxy/providers/registry.ts` — export `refreshCbcModels()`.
5. `src/index.ts` — panggil `refreshCbcModels()` di startup.
6. `src/api/models.ts` (baru) — router CRUD.
7. `src/api/index.ts` — mount `modelsRouter`.
8. `dashboard/src/lib/api.ts` — fungsi + tipe API.
9. `dashboard/src/pages/Models.tsx` — UI manajemen model.
10. `test/proxy/cbc-models.test.ts` (baru) — tes regresi.
11. `CLAUDE.md` — dokumentasi.
