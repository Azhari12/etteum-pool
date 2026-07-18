# Plan: Perbaikan Vision `[object Object]` + Sinkronisasi Running Fix

## Temuan

### A. Perbedaan FIX vs REF (C:\KODING\etteum-pool)
Kedua project HEAD sama (`a28db51`). Project REF punya perubahan **uncommitted** = fix "running" (Bun crash di Windows + path drive). Project FIX belum punya. File berubah di REF:
- `src/index.ts` — block non-GET/HEAD jatuh ke static file serving (crash Bun Windows)
- `scripts/start.ts` — fix Windows drive path (`/C:/...` → `C:/...`)
- `scripts/production.ts` — fix Windows drive path sama
- `scripts/serve-dashboard.ts` — hanya GET/HEAD yang serve file
- `install.ps1`, `etteum.ps1` — installer/script changes

### B. Bug vision `[object Object]` (BELUM ada di kedua project)
Root cause: response GLM vision mengirim `delta.content` / `message.content` sebagai **array/object** (mis. `[{type:"text", text:"..."}]`), bukan string. Konverter pakai `+=` / assignment langsung → `String(array/object)` → `"[object Object]"`.

3 titik bug:
1. `src/proxy/providers/codebuddy-china.ts:772` — non-stream: `if (delta.content) content += delta.content;`
2. `src/proxy/providers/codebuddy-china.ts:843-853` — stream passthrough `delta` tanpa normalisasi
3. `src/proxy/transforms/anthropic.ts:325` (`const text = delta.content || "";` stream→text_delta) & `:141` (`const text = choice?.message?.content || "";` non-stream openAIToAnthropic)

## Yang akan dikerjakan

### 1. Sinkronisasi running fix REF → FIX
Salin persis diff uncommitted REF ke FIX untuk: `src/index.ts`, `scripts/start.ts`, `scripts/production.ts`, `scripts/serve-dashboard.ts`, `install.ps1`, `etteum.ps1`.

### 2. Fix vision `[object Object]` (baru, di FIX)
Tambah helper normalisasi content → string murni. Terapkan di lapisan transform (titik konversi ke Anthropic, sesuai arah prompt) + provider (passthrough konsisten).

**a. `src/proxy/transforms/anthropic.ts`** — helper `contentToPlainText(content)`:
- string → langsung
- array → join `.text` tiap block `text` (handle nested)
- object → ambil `.text`/`.content`/fallback
- fallback `""`

Terapkan:
- `openAIToAnthropic` L141: `const text = contentToPlainText(choice?.message?.content) || "";`
- `openAIStreamToAnthropic` L325: `const text = contentToPlainText(delta.content) || "";`

**b. `src/proxy/providers/codebuddy-china.ts`** — helper lokal `normalizeContent`:
- non-stream L772: `const c = normalizeContent(delta.content); if (c) content += c;`
- stream L843: normalisasi `delta.content` (dan `reasoning_content`) jadi string di salinan delta sebelum enqueue.

### 3. Testing
- Typecheck: `bunx tsc --noEmit`
- Run dengan port BUKAN 1930/1931: `PORT=1940 DASHBOARD_PORT=1941`
- Test vision: `POST /v1/messages` ke port 1940, model `cbc-glm-5.2`, content block `image` base64 + `text`. Pastikan `content[0].text` = string deskripsi, BUKAN `[object Object]`.

## Catatan
- Hindari port 1930 & 1931 (dipakai REF). Pakai 1940/1941.
- cbc-glm-5.2 sudah `vision: true` (tidak diubah).
- Backup via git (file sudah tracked).
