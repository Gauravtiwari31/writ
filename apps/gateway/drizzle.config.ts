import { defineConfig } from "drizzle-kit";

// `db:generate` only diffs the TypeScript schema against ./drizzle and needs no database.
// DATABASE_URL is read for the optional `drizzle-kit migrate` / `studio` commands.
const url = process.env.DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
  ...(url ? { dbCredentials: { url } } : {}),
});
