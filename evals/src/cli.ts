// `pnpm eval --mode rules` or `pnpm eval --mode sink --agent atlas|scout` (plan §13). Results are written only
// from a real run, to evals/results/<date>-<commit>-<mode>.json. Sink mode refuses to run without a model.
import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "./runner";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const mode = arg("mode") ?? "rules";
const agent = arg("agent") ?? "atlas";
if ((mode !== "rules" && mode !== "sink") || (agent !== "atlas" && agent !== "scout")) {
  console.error("usage: pnpm eval --mode rules | --mode sink --agent atlas|scout");
  process.exit(2);
}
if (existsSync(`${ROOT}.env`)) process.loadEnvFile(`${ROOT}.env`);

try {
  const { results, summary } = await run({ mode, agent, env: process.env });
  const commit = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
  const date = new Date().toISOString().slice(0, 10);
  const label = mode === "sink" ? `sink-${agent}` : "rules";
  const file = `evals/results/${date}-${commit}-${label}.json`;
  const assumption = mode === "rules" ? "No model was used. The agent is ASSUMED fully hijacked: the attacker's exact request is submitted to the real gateway. PayPal is stubbed only inside evals." : "A real agent model read the poisoned pages. PayPal is stubbed only inside evals.";
  writeFileSync(`${ROOT}${file}`, `${JSON.stringify({ benchmark: "WritBench-lite", mode: label, commit, date, assumption, summary, results }, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`wrote ${file}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
