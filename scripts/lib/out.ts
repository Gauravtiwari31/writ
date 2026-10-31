// Spike outputs land in scripts/.out/ (git-ignored); the PASS/FALLBACK summary is copied into docs/SPIKES.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { REPO_ROOT } from "./env";

export const OUT_DIR = resolve(REPO_ROOT, "scripts/.out");

function outPath(name: string): string {
  return resolve(OUT_DIR, name);
}

/** Writes JSON; bigint values are written as decimal strings. Returns the absolute path. */
export function writeOut(name: string, data: unknown): string {
  const path = outPath(name);
  mkdirSync(dirname(path), { recursive: true });
  const json = JSON.stringify(data, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value), 2);
  writeFileSync(path, `${json}\n`, "utf8");
  return path;
}

export function readOut<T = unknown>(name: string): T | undefined {
  const path = outPath(name);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
