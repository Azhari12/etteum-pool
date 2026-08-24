/**
 * Give a test file its own scratch database instead of the live one.
 *
 * `src/db/index.ts` opens `config.databasePath` once, at module load, so the
 * redirect has to happen before anything imports it. Two consequences:
 *
 *  - Call `prepareScratchDatabase()` at the top of the test file, then load
 *    `src/db` (and anything that touches it) with `await import(...)`.
 *  - `bun test` runs every file in ONE process with a shared module cache, so
 *    if an earlier file already opened the database this redirect is too late.
 *    `assertUsingScratchDatabase()` detects that and lets the caller skip
 *    rather than mutate real accounts.
 *
 * There is no checked-in DDL to build a blank database from (drizzle/ is
 * gitignored — see src/db/migrate.ts), so the schema is copied from the live
 * file with `VACUUM INTO` and then emptied of rows. The live file is only ever
 * opened read-only.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dir, "..");

export interface ScratchDatabase {
  /** Absolute path of the scratch file, or null when it could not be built. */
  path: string | null;
  /** Why it could not be built — surfaced in the skip message. */
  reason?: string;
}

export function prepareScratchDatabase(name: string): ScratchDatabase {
  const sourceDb =
    process.env.SOURCE_DATABASE_PATH || path.join(projectRoot, "data/poolprox3.db");
  if (!existsSync(sourceDb)) {
    return {
      path: null,
      reason: `no schema source at ${sourceDb} (set SOURCE_DATABASE_PATH or run the app once)`,
    };
  }

  const target = path.join(projectRoot, "data", `test-${name}.db`);
  mkdirSync(path.dirname(target), { recursive: true });
  removeDatabaseFiles(target);

  const source = new Database(sourceDb, { readonly: true });
  try {
    source.prepare("VACUUM INTO ?").run(target);
  } finally {
    source.close();
  }

  // Keep the schema, drop the copied rows.
  const scratch = new Database(target);
  try {
    const tables = scratch
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as Array<{ name: string }>;
    scratch.exec("PRAGMA foreign_keys = OFF");
    for (const { name: table } of tables) {
      scratch.exec(`DELETE FROM "${table}"`);
    }
    scratch.exec("PRAGMA foreign_keys = ON");
  } finally {
    scratch.close();
  }

  process.env.DATABASE_PATH = target;
  return { path: target };
}

/**
 * Confirm the loaded db module actually opened the scratch file. Returns a
 * skip reason when it did not, so the caller can bail out instead of writing
 * to the live database.
 */
export function assertUsingScratchDatabase(
  scratch: ScratchDatabase,
  actualDatabasePath: string
): string | null {
  if (!scratch.path) {
    return `scratch database unavailable: ${scratch.reason}`;
  }
  if (path.resolve(actualDatabasePath) !== path.resolve(scratch.path)) {
    return (
      `database already opened at ${actualDatabasePath} by an earlier test file — ` +
      `run this file on its own (bun test <file>) so it gets an isolated database`
    );
  }
  return null;
}

/** Best-effort removal; an open handle on Windows makes rm throw. */
export function removeDatabaseFiles(file: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${file}${suffix}`, { force: true });
    } catch {
      /* still held open — the next run overwrites it */
    }
  }
}
