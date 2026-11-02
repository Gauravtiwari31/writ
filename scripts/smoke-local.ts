// `pnpm smoke:local`: checks a local run (`pnpm dev`) end to end over HTTP. Today it verifies what
// exists: gateway health, GET /v1/meta, the Wallet page, and the Wallet's /gw rewrite to the
// gateway. Owner: judge stream, which extends it to act as an external agent over the public agent
// API (AgentApiClient from @writ/agents) through the hero flow once those routes exist.
import { MetaResponseSchema } from "@writ/core/api";
import { optionalEnv } from "./lib/env";

const gateway = optionalEnv("GATEWAY_BASE_URL") ?? `http://localhost:${optionalEnv("PORT") ?? "10000"}`;
const wallet = optionalEnv("APP_BASE_URL") ?? "http://localhost:3000";

interface Check {
  name: string;
  run(): Promise<string>;
}

async function get(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json, text/html" } });
}

const checks: Check[] = [
  {
    name: "gateway /healthz",
    async run() {
      const res = await get(`${gateway}/healthz`);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return JSON.stringify(await res.json());
    },
  },
  {
    name: "gateway /v1/meta",
    async run() {
      const res = await get(`${gateway}/v1/meta`);
      const meta = MetaResponseSchema.parse(await res.json());
      return `db=${meta.database} paypal=${meta.paypal.configured} compiler=${meta.ai.compiler} agent=${meta.ai.agent} channel3=${meta.channel3}`;
    },
  },
  {
    name: "wallet /",
    async run() {
      const res = await get(`${wallet}/`);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return `${(await res.text()).length} bytes of HTML`;
    },
  },
  {
    name: "wallet /gw rewrite → gateway",
    async run() {
      const res = await get(`${wallet}/gw/v1/meta`);
      const meta = MetaResponseSchema.parse(await res.json());
      return `reached ${meta.service} through the Wallet origin`;
    },
  },
];

let failed = 0;
for (const check of checks) {
  try {
    console.log(`PASS ${check.name}: ${await check.run()}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(failed === 0 ? "smoke: all checks passed" : `smoke: ${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
