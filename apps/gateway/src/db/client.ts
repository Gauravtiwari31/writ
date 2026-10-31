import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { is, type SQL } from "drizzle-orm";
import { drizzle as drizzleNodePg, NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
// Type-only: drizzle-orm/pglite imports PGlite at runtime, and PGlite is a devDependency.
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { Pool, PoolConfig } from "pg";
import * as schema from "./schema";

export type Schema = typeof schema;

/** Anything that runs queries against the Writ schema: a pooled db, a PGlite db, or a transaction of either. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export type PgDb = NodePgDatabase<Schema> & { $client: Pool };
export type PgliteDb = PgliteDatabase<Schema> & { $client: PGlite };
export type AppDb = PgDb | PgliteDb;

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

// Arbitrary constant ("writ" in ASCII); every gateway instance contends on the same advisory lock.
const MIGRATION_LOCK_KEY = 0x77726974;

export function createPgDb(databaseUrl: string, pool: Omit<PoolConfig, "connectionString"> = {}): PgDb {
  return drizzleNodePg({ connection: { ...pool, connectionString: databaseUrl }, schema });
}

/** In-memory Postgres (WASM) for tests. Loaded lazily so production never imports a devDependency. */
export async function createPgliteDb(): Promise<PgliteDb> {
  const [{ PGlite }, { drizzle }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
  ]);
  const client = new PGlite();
  await client.waitReady;
  return drizzle({ client, schema });
}

function isNodePg(db: AppDb): db is PgDb {
  return is(db, NodePgDatabase);
}

/**
 * Applies ./drizzle migrations. On a real server the run holds a session advisory lock on a single
 * connection, so instances (or test files) starting together cannot race on CREATE TABLE.
 */
export async function runMigrations(db: AppDb): Promise<void> {
  const config = { migrationsFolder: MIGRATIONS_FOLDER };
  if (!isNodePg(db)) {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db, config);
    return;
  }
  const client = await db.$client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await migrateNodePg(drizzleNodePg({ client, schema }), config);
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export async function closeDb(db: AppDb): Promise<void> {
  if (isNodePg(db)) await db.$client.end();
  else await db.$client.close();
}

/**
 * Rows of a raw statement. Both drivers return `{ rows }`, but the shared Db type cannot express
 * that, so the row type is the caller's assertion: keep raw SQL to queries whose shape is obvious.
 */
export async function executeRows<T>(db: Db, query: SQL): Promise<T[]> {
  const result: unknown = await db.execute(query);
  if (typeof result === "object" && result !== null && "rows" in result && Array.isArray(result.rows)) {
    return result.rows as T[];
  }
  throw new TypeError("driver returned no rows array");
}
