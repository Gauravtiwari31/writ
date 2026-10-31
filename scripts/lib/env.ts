// Loads the repo-root .env (if present) so every spike runs the same from any cwd.
// Never print secret values; print only which variables are set.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const envPath = resolve(REPO_ROOT, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing ${name}. Set it in ${envPath} (see .env.example).`);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** Reports which of the given variables are set, without revealing their values. */
export function describeEnv(names: readonly string[]): string {
  return names.map((name) => `${name}=${optionalEnv(name) === undefined ? "MISSING" : "set"}`).join("  ");
}
