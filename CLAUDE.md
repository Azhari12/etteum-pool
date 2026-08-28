# CLAUDE.md

Guidance for Claude Code working in this repository. Read this first.

## What this is

**Etteum Pool** — a TypeScript/Bun AI proxy pool. It sits in front of many upstream AI provider accounts (Kiro, CodeBuddy, Codex, Canva, Qoder, GitLab Duo, YouMind, plus user-supplied BYOK keys), exposes an OpenAI/Anthropic-compatible API, load-balances across accounts, auto-refreshes sessions, tracks credits, and ships a React dashboard. This is the **private** repo (GitLab Duo + YouMind + debug tooling not in the public mirror).

- **Runtime:** Bun 1.x (not Node). TypeScript, strict mode, `verbatimModuleSyntax`.
- **Framework:** Hono (backend API + proxy routes), React 19 + Vite 8 + Tailwind 4 + React Router 7 (dashboard).
- **DB:** SQLite via `drizzle-orm/bun-sqlite`. Schema in `src/db/schema.ts`. File at `data/poolprox3.db` (gitignored).
- **Auth automation:** Python 3.10+ venv at `scripts/auth/.venv` using Playwright + Camoufox for browser-based provider logins.

## Quick reference — commands

```bash
bun run dev        # dev: backend (:1930) + Vite dashboard (:1931), via scripts/start.ts
bun run start      # production: builds dashboard, serves backend + static dashboard
bun run start:fast # production but skip dashboard rebuild
bun run build      # build dashboard only (cd dashboard && bun run build)
bun run migrate    # run DB migrations (src/db/migrate.ts)
bun run doctor     # health diagnostic (scripts/doctor.ts)
bun run preflight  # post-install verification (scripts/preflight.ts)

bun test                                    # full suite (see Testing section below)
bun test test/proxy/errors.test.ts          # one file
bun test test/proxy/router-errors.test.ts  # MUST run on its own (see below)

etteum start|stop|restart|status|logs      # management CLI (etteum.ps1 / etteum shell script)
```

Env is in `.env` (gitignored). Key vars (see `src/config.ts` for all):

| Var | Default | Purpose |
|---|---|---|
| `PORT` | 1930 | Backend API + proxy |
| `DASHBOARD_PORT` | 1931 | Dashboard |
| `API_KEY` | (generated) | `Authorization: Bearer <key>` for clients |
| `DATABASE_PATH` | `./data/poolprox3.db` | SQLite file |
| `ENCRYPTION_KEY` | (generated) | 32 hex chars — encrypts account passwords/tokens |
| `AUTH_SCRIPT_PATH` | `./scripts/auth/login.py` | Python auth bot entrypoint |
| `PYTHON_PATH` | (auto) | venv python; leave empty for auto-detect |
| `BROWSER_ENGINE` | `camoufox` | `camoufox` (anti-detect) or `chromium` |
| `HEADLESS` | `true` | browser headless mode |
| `PROXY_URL` | (empty) | outbound proxy for the auth bot |
| `KIRO_PRO_UPGRADE` | `false` | VCC-pool auto-upgrade |

## Project layout

```
src/
  index.ts              # Hono app entry. Mounts routers, runs migrations on boot, seeds filters.
  config.ts             # all env-driven config (single source)
  api/                  # REST endpoints: accounts, stats, settings, keys, image-studio,
                        #   oauth, proxy-pool, proxy-settings, vcc, filters, integration, bin
  auth/                 # login queue + runner (spawns Python bot), warmup runner/scheduler
  db/                   # schema.ts (tables), index.ts (drizzle client), migrate.ts
  proxy/                # ← the core (see below)
  services/             # proxy-pool.ts, proxy-scraper.ts (background services)
  lib/client-configs/   # generates client config bundles (codex, hermes, kilo, openclaw, opencode)
  utils/                # crypto.ts (AES encrypt/decrypt), jwt.ts
  ws/                   # WebSocket server — broadcasts live account/request events to dashboard
dashboard/              # React 19 + Vite + Tailwind. Pages: Dashboard, Usage, etc.
scripts/
  start.ts              # dev launcher (backend + vite)
  production.ts         # production launcher (build + static serve)
  doctor.ts, preflight.ts
  auth/                 # Python automation: app/providers/ (kiro, codebuddy, qoder, canva...),
                        #   login.py entrypoint, requirements.txt, venv at .venv
  serve-dashboard.ts
docs/
  compression.md        # token compression pipeline reference
test/
  proxy/                # unit + integration tests (errors, routing, byok, kiro, etc.)
  auth/
  scratch-db.ts         # builds an isolated SQLite copy for tests that write to accounts
etteum / etteum.ps1     # management CLI (start/stop/restart/status/logs)
poolprox / aiproxy      # alternate management CLI shims
poolprox3.service       # systemd user unit (production)
```

## The proxy core (`src/proxy/`)

This is the heart of the project. Request flow:

```
client request
  → Hono route (src/proxy/index.ts: /v1/chat/completions, /v1/messages, /v1/models)
  → normalizeModelId + resolveModelAlias   (model-mapping.ts)
  → sanitizeRequest                         (filters.ts — strip assistant identity etc.)
  → compressRequest                         (compression/ — RTK/DCP/Caveman/image-dedupe/cache-markers)
  → routeRequest                            (router.ts — pick provider, pick account, retry)
  → provider.chatCompletion / chatCompletionStream
  → log + broadcast WS event
```

### Provider registry (`providers/registry.ts`)

Single source of truth. `PROVIDER_ORDER` lists providers; `getProviderForModel(model)` walks the list and returns the first whose `ownsModel(model)` is true. Order matters **only** for disambiguating overlapping model patterns — more specific providers first.

```
PROVIDER_ORDER = [gitlabDuo, canva, qoder, codex, kiroPro, youmind, byok, codebuddyChina, codebuddy, kiro]
```

- `kiro` is the **fallback** (`isFallback = true`) — unknown models route to it last.
- `kiro` and `kiro-pro` are the **same class** (`KiroProvider` with `variant`), same upstream (AWS CodeWhisperer), different model catalog + account pool.
- `byok` is special — it owns models by **dynamic DB-driven prefixes**, not a static list (see below).

Providers: `kiro`, `kiro-pro`, `codebuddy`, `codebuddy-china`, `canva`, `codex`, `qoder`, `byok`, `gitlab-duo`, `youmind`.

**To add/remove/change a provider:** touch (1) that provider's file, (2) one line in `PROVIDER_ORDER`. No per-provider routing logic lives elsewhere.

### Base provider contract (`providers/base.ts`)

Each provider extends `BaseProvider` and implements:
- `chatCompletion(account, request)` / `chatCompletionStream(...)` → `ProviderResult`
- `refreshToken(account)` — re-auth when a token expires
- `ownsModel(model)` / `getModels()` / `getModelInfo(model)`
- `getQuotaSnapshot(account)` / `checkHealth(account)` (warmup uses these)

`ProviderResult` carries `{ success, response?, stream?, error?, rateLimited?, quotaExhausted?, tokens?, ... }`. The `rateLimited` / `quotaExhausted` flags drive how the router treats the failure — they're the primary signal, not error-string parsing.

### BYOK provider (`providers/byok.ts`) — prefix-based routing

BYOK (Bring Your Own Key) accounts each declare a `model_prefix` in their `tokens` JSON, plus a list of `models` and a `base_url`. A request for `kuzu-hoshi/deepseek-ai/DeepSeek-V4-Flash` is matched to prefix `kuzu`, then the model sent upstream is the remainder (`hoshi/deepseek-ai/DeepSeek-V4-Flash`).

- `prefixCache: Map<prefix, CachedByokAccount[]>` — built from DB, 10s TTL. Multiple accounts can share a prefix (load-balanced as a group).
- **Load balancing** per prefix (from `tokens.load_balancing_method`): `round_robin` (default, with least-in-flight tie-break), `sequential`, `least_inflight`.
- Supports both `openai` (`/chat/completions`) and `anthropic` (`/messages`) upstream formats, auto-detected from `base_url` or explicit `tokens.format`.
- Account selection tiers (in `findAccountForModel`): active → error → exhausted (one-shot per refresh cycle).
- `refreshByokModels()` must be called after any BYOK account CRUD so the cache rebuilds.

### Router (`router.ts`) — `routeRequest(request, stream)`

1. Resolve provider via `pool.getProviderForModel(model)`.
2. Compress the request.
3. Retry loop (up to 3 accounts):
   - BYOK: `pool.getAccountForModel(model, { excludeAccountIds })` — prefix-based, can retry error/exhausted accounts.
   - Others: `pool.getNextAccount(provider)`; on no active account, try one exhausted fallback per cycle.
   - On success: mark used, persist refreshed tokens, return.
   - On failure: classify — `isNonAccountRequestError` throws immediately (bad model/moderation = client's fault, don't poison accounts); `rateLimited`/`quotaExhausted`/`isTransientError` keep the account active; otherwise `markError`.
4. If every account failed → throws **`AllAccountsFailedError`** carrying `{ provider, upstreamError, upstreamStatus, rateLimited, quotaExhausted, attempts, lastAccountEmail }`.
5. If no candidate was ever found (attempt 0, no account) → throws `No active accounts available for provider: X`.

### Error classification (`errors.ts`)

- `extractHttpStatus(error)` — pulls an HTTP status out of any provider's formatting (`HTTP 502:`, `(502)`, `status 502`).
- `isInvalidModelError` / `isBadUpstreamRequest` / `isContentModerationError` → `isNonAccountRequestError` (don't retry, client's fault).
- `isTransientError(error)` — status-code-first (transient statuses: 400, 408, 425, 429, 5xx), then network/stream substrings. 400 is transient *only* via request-shape phrases; genuinely-unrecoverable 400s are caught earlier by `isNonAccountRequestError`. Stream-error patterns are word-anchored (`/\bstream (error|failed)\b/`) so `"upstream error"` isn't accidentally matched.

### API error responses (`proxy/index.ts`)

`describeProxyError(error, errorMessage)` maps a routing failure to an honest client response instead of a flat 503:

| Cause | HTTP status | code |
|---|---|---|
| invalid model / bad request | 400 | `invalid_model` / `invalid_request` |
| rate limit / quota exhausted | 429 | `rate_limit_exceeded` |
| upstream 5xx | 502 | `upstream_error` |
| otherwise | 503 | `proxy_error` |

The response body includes `error.upstream: { provider, status?, attempts, account?, rateLimited?, quotaExhausted?, error }` so callers can see the real cause. Applies to both `/v1/chat/completions` and `/v1/messages`.

## Database

SQLite at `data/poolprox3.db`. Schema in `src/db/schema.ts`. Tables: `accounts`, `request_logs`, `settings`, `usage_summary`, `vcc_cards`, `vcc_transactions`, `image_studio_chats`, `image_studio_results`, `filter_rules`, `proxy_pool`, `model_mappings`.

**`accounts` table** — key columns: `id`, `provider`, `email`, `password` (encrypted), `tokens` (jsonb — access/refresh tokens, BYOK config), `status`, `enabled`, quota + free-counter fields, `errorMessage`, timestamps.

**Account statuses:** `active` | `exhausted` | `error` | `pending`.
- `active` — in the live rotation pool.
- `exhausted` — out of credits; retryable as one-shot fallback per refresh cycle, reactivated on a successful request.
- `error` — last attempt failed non-transiently; still claimable for BYOK ownership, tried after active.
- `pending` — not yet warmed/logged in.

**Migrations:** `src/db/migrate.ts`. The `drizzle/` folder is gitignored, so file-based migrations only run if present. On fresh deploys, idempotent `ALTER TABLE ... ADD COLUMN` statements (the `IDEMPOTENT_COLUMNS` list) handle new columns. To push schema changes locally: `bunx drizzle-kit push` (config in `drizzle.config.ts`).

## Token compression pipeline (`src/proxy/compression/`)

Reduces input tokens before forwarding upstream. Runs in <10ms, non-fatal (on failure, the sanitized request passes through). Order: DCP (dedup tools) → RTK (truncate tool results) → Caveman (compact system prompt) → image dedupe → cache markers. Config is DB-backed (`settings` table) with a 10s TTL. Telemetry written to `request_logs.compression_stats`. See `docs/compression.md` for the full reference.

## Auth & warmup (`src/auth/` + `scripts/auth/`)

Most providers need browser-based login to capture session tokens. `scripts/auth/login.py` (Python, Playwright/Camoufox) is spawned per-account by `src/auth/runner.ts` via a queue. Provider-specific login flows live in `scripts/auth/app/providers/` (kiro, codebuddy, qoder, canva, codex, gitlab_duo, kiro_pro, wavespeed, yepapi...). Default browser engine is Camoufox (anti-detect); `chromium` is the alternative.

**Warmup** (`src/auth/warmup-runner.ts`, `warmup-scheduler.ts`): periodically refreshes each account's quota/health from upstream and flips statuses (e.g. Qoder re-syncs `freeRemaining` from `/activity`; exhausted accounts get reactivated when upstream reports credits again). `autoWarmupScheduler` starts on boot.

## Dashboard (`dashboard/`)

React 19 + Vite 8 + Tailwind 4. Built with `bun run build` → `dashboard/dist/`, served statically in production. In dev, Vite runs on `DASHBOARD_PORT`. Consumes the WebSocket feed from the backend for live account/request/usage updates.

## Conventions

- **Never hardcode a provider's routing logic outside the registry.** `getProviderForModel` is the single router.
- **Error messages must surface upstream detail.** Don't flatten upstream failures to a generic 503 — use `describeProxyError` / `AllAccountsFailedError` so the client sees the real cause.
- **Don't poison accounts for client-side errors.** A bad model ID or content-moderation reject is `isNonAccountRequestError` — throw, don't `markError`.
- **`extractHttpStatus` over substring matching** for status-based classification — providers format statuses inconsistently.
- **BYOK:** call `refreshByokModels()` after any account CRUD; the prefix cache is the routing source of truth.
- **Account passwords and tokens are encrypted** (`src/utils/crypto.ts` + `ENCRYPTION_KEY`). Never log raw secrets.
- **Commit discipline:** conventional-ish messages; end commits with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Only commit/push when asked; branch off the default branch first.

## Testing

`bun test` runs the suite. Tests live in `test/` (mirrors `src/`).

**⚠️ Tests write to the `accounts` table.** Several existing tests (e.g. `test/proxy/byok-provider.test.ts`) call `db.delete(accounts)` directly. Because `bun test` runs all files in one process with a shared module cache, and `src/db/index.ts` opens `DATABASE_PATH` once at load, these can hit the **live** `data/poolprox3.db`. Today that's only prevented by `request_logs` foreign keys blocking the delete — don't rely on that.

- `test/scratch-db.ts` builds an isolated SQLite copy (via `VACUUM INTO` from the live file, read-only, then emptied) for tests that need to write. A test that uses it must run **on its own** (`bun test <file>`), because an earlier file may have already opened the live DB — `assertUsingScratchDatabase` detects this and the test skips with a clear message rather than mutating real accounts.
- `test/proxy/router-errors.test.ts` — **run standalone**: `bun test test/proxy/router-errors.test.ts`. Covers `AllAccountsFailedError`, upstream-error surfacing, transient 502 not poisoning accounts, and HTTP responses on `/v1/chat/completions` + `/v1/messages`.
- `test/proxy/errors.test.ts` — error classification (`extractHttpStatus`, `isTransientError` regressions like `"Hoshi upstream error"` not matching `stream error`).

When debugging a specific provider/route, prefer the ad-hoc scripts at the repo root (`check-byok-status.ts`, `debug-byok.ts`, `test-routing.ts`, `reset-account.ts`, etc.) as reference — but **run them against a scratch DB** (`DATABASE_PATH=./data/test.db`) or read-only, never the live pool.
