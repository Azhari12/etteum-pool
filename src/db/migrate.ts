import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db, client } from "./index";
import { existsSync } from "node:fs";
import { sql } from "drizzle-orm";

/**
 * Idempotent column-add migrations.
 * The drizzle/ folder is gitignored in this repo — fresh deploys would never
 * see file-based migrations for new columns. Each entry below adds a column
 * if it doesn't already exist; safe to run on every boot.
 *
 * Order: from oldest schema additions to newest. Add to the END of the list
 * when you add a new column to schema.ts.
 */
const IDEMPOTENT_COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  // 2026-06-13 — compression_stats (token-saver telemetry, see src/proxy/compression/)
  { table: "request_logs", column: "compression_stats", ddl: "ALTER TABLE request_logs ADD COLUMN compression_stats TEXT" },
  // 2026-06-14 — Qoder Free counter (mirrors /activity qmodel_latest promo).
  // Decremented per-request when the model maps to qmodel_latest. Synced (and
  // overridden) from Qoder by warmup. See src/auth/warmup-runner.ts.
  { table: "accounts", column: "free_limit",     ddl: "ALTER TABLE accounts ADD COLUMN free_limit REAL DEFAULT 0" },
  { table: "accounts", column: "free_remaining", ddl: "ALTER TABLE accounts ADD COLUMN free_remaining REAL DEFAULT 0" },
  { table: "accounts", column: "free_reset_at",  ddl: "ALTER TABLE accounts ADD COLUMN free_reset_at INTEGER" },
];

function tableHasColumn(table: string, column: string): boolean {
  try {
    const rows = client.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

async function runIdempotentColumns() {
  for (const m of IDEMPOTENT_COLUMNS) {
    if (tableHasColumn(m.table, m.column)) continue;
    try {
      await db.run(sql.raw(m.ddl));
      console.log(`[DB] Added column ${m.table}.${m.column}`);
    } catch (err) {
      // Re-check: another process may have added it concurrently.
      if (!tableHasColumn(m.table, m.column)) {
        console.error(`[DB] Failed to add ${m.table}.${m.column}:`, err);
      }
    }
  }
}

export async function runMigrations() {
  const migrationsFolder = "./drizzle";

  // Only run file-based migrations if the folder exists
  if (existsSync(`${migrationsFolder}/meta/_journal.json`)) {
    console.log("[DB] Running migrations...");
    await migrate(db, { migrationsFolder });
    console.log("[DB] Migrations complete.");
  } else {
    console.log("[DB] No migrations found, skipping. Use 'bun run db:push' to sync schema.");
  }

  // Always run idempotent column-add migrations (works on fresh deploys without drizzle/).
  await runIdempotentColumns();

  // Ensure codebuddy-china dynamic model catalog exists. Idempotent CREATE —
  // safe on every boot, same pattern as ensureModelMappingTable.
  ensureCbcModelsTable();
}

/**
 * Create the cbc_models table if it does not exist. The drizzle migration
 * journal in this repo is inconsistent, so we guarantee the table at runtime
 * with an idempotent CREATE rather than relying on the migrator alone.
 */
export function ensureCbcModelsTable(): void {
  client.exec(`
    CREATE TABLE IF NOT EXISTS cbc_models (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      model_id text NOT NULL UNIQUE,
      upstream_model text NOT NULL,
      label text,
      context_window integer NOT NULL DEFAULT 200000,
      max_output integer NOT NULL DEFAULT 8192,
      thinking integer NOT NULL DEFAULT 0,
      vision integer NOT NULL DEFAULT 0,
      credit_unit text NOT NULL DEFAULT 'credit',
      credit_rate real NOT NULL DEFAULT 0.01,
      credit_source text NOT NULL DEFAULT 'upstream',
      enabled integer NOT NULL DEFAULT 1,
      created_at integer NOT NULL,
      updated_at integer
    );
  `);
}

// Run if called directly
if (import.meta.main) {
  await runMigrations();
  console.log("[DB] Database migrated successfully");
  process.exit(0);
}
