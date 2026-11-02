// Plan decision 4: local runs need no external services. DATABASE_URL=pglite:<dir> opens a
// file-backed PGlite, migrations apply at startup, and the data survives a restart.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { loadGatewayConfig } from "../src/config";
import { closeDb, databaseKind, openDatabase, runMigrations, type AppDb } from "../src/db/client";
import { newRowId } from "../src/db/ids";
import { users } from "../src/db/schema";

const dir = mkdtempSync(join(tmpdir(), "writ-pglite-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The tests run in order: boot on a fresh data directory, write through the gateway's database,
// then restart on the same directory.
describe("file-backed PGlite (local runs)", () => {
  const dataDir = join(dir, "gateway");
  const config = loadGatewayConfig({ PAYPAL_ENV: "sandbox", DATABASE_URL: `pglite:${dataDir}`, JOBS_ENABLED: "false" });
  const userId = newRowId("user");
  let first: AppDb;

  // Creating the cluster on disk (initdb, ~3 s idle and more on a busy machine) plus the migrations
  // is one-time setup, exactly what server.ts does at startup.
  beforeAll(async () => {
    first = await openDatabase(config.database);
    await runMigrations(first);
  });

  it("parses pglite:<dir> into a file-backed PGlite database", () => {
    expect(config.database).toEqual({ kind: "pglite", dataDir });
    expect(databaseKind(first)).toBe("pglite");
  });

  it("boots the gateway on it with every migration applied", async () => {
    const app = await buildApp(config, { db: first, logger: false });
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/meta" })).json()).toMatchObject({ database: "pglite", paypal: { configured: false } });
    await first.insert(users).values({ id: userId, tenantId: newRowId("tenant"), displayName: "Ana" });
    await app.close();
    await closeDb(first);
  });

  it("keeps data across a restart (migrations are a no-op the second time)", async () => {
    const second = await openDatabase(config.database);
    await runMigrations(second);
    const [row] = await second.select().from(users).where(eq(users.id, userId));
    expect(row?.displayName).toBe("Ana");
    await closeDb(second);
  });
});
