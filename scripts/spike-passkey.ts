// Spike S6 (plan §17): can a passkey sign an arbitrary hash, SHA-256(JCS(Writ)), on desktop Chrome
// and on a phone, with the server verifying it? Serves the gateway's spike plugin standalone on
// 127.0.0.1. A local run proves the mechanism; the S6 PASS needs the same page on the Render domain.
//
//   pnpm spike spike-passkey.ts [--port 8788] [--rp-id <host> --origin <https-url>] [--self-test]
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { hashJcs, toBase64Url } from "@writ/core";
import Fastify, { type FastifyInstance } from "fastify";
import {
  PASSKEY_SPIKE_PREFIX,
  passkeySpikePlugin,
  type ClientInfo,
  type PasskeySpikeEvent,
  type PasskeySpikeReport,
} from "../apps/gateway/src/spikes/passkey";
import { describeEnv, optionalEnv } from "./lib/env";
import { writeOut } from "./lib/out";

const OUT_FILE = "s6-passkey.json";
const DEFAULT_PORT = 8788;

const USAGE = `Spike S6: passkey signing over a Writ hash (plan §17)

Usage: pnpm spike spike-passkey.ts [options]

  --port <n>        Port on 127.0.0.1 (default: SPIKE_PASSKEY_PORT or ${DEFAULT_PORT})
  --rp-id <host>    WebAuthn RP ID (default: localhost). Only for an HTTPS tunnel; then also pass --origin.
  --origin <url>    Extra accepted origin, e.g. https://abc.trycloudflare.com (repeatable)
  --self-test       Build the app, check the page and that the challenge is SHA-256(JCS(Writ)), then exit
  -h, --help        Show this help

While running: press Enter to print the current verdict and markdown, "q" + Enter (or Ctrl+C) to stop.
The final report is printed on exit and saved to scripts/.out/${OUT_FILE}.`;

class UsageError extends Error {}

interface Args {
  port: number;
  rpID: string;
  origins: string[];
  selfTest: boolean;
}

function parsePort(raw: string, source: string): number {
  if (!/^\d+$/.test(raw)) throw new UsageError(`${source} must be an integer port, got "${raw}"`);
  const port = Number(raw);
  if (port < 1 || port > 65_535) throw new UsageError(`${source} must be between 1 and 65535, got ${port}`);
  return port;
}

function parseCli(argv: string[]): Args | "help" {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        port: { type: "string" },
        "rp-id": { type: "string" },
        origin: { type: "string", multiple: true },
        "self-test": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error), { cause: error });
  }
  const { values } = parsed;
  if (values.help === true) return "help";
  const envPort = optionalEnv("SPIKE_PASSKEY_PORT");
  const port =
    values.port !== undefined
      ? parsePort(values.port, "--port")
      : envPort !== undefined
        ? parsePort(envPort, "SPIKE_PASSKEY_PORT")
        : DEFAULT_PORT;
  const rpID = values["rp-id"] ?? "localhost";
  const origins = values.origin ?? [];
  if (rpID !== "localhost" && origins.length === 0) {
    throw new UsageError(`--rp-id ${rpID} needs --origin https://${rpID} (the browser origin the page is served from)`);
  }
  return { port, rpID, origins, selfTest: values["self-test"] === true };
}

function short(id: string): string {
  return id.length > 16 ? `${id.slice(0, 16)}...` : id;
}

function clientText(client: ClientInfo): string {
  return `${client.browser} on ${client.os}, ${client.mobile ? "mobile" : "desktop"}`;
}

function printEvent(event: PasskeySpikeEvent): void {
  switch (event.type) {
    case "registered": {
      const c = event.credential;
      console.log(
        `[S6] passkey registered: ${c.authenticatorName}; attachment ${c.authenticatorAttachment ?? "n/a"}; ` +
          `transports ${c.transports.join(",") || "n/a"}; ${c.credentialDeviceType}${c.credentialBackedUp ? " (backed up)" : ""}; ` +
          `UV=${event.userVerified ? 1 : 0}; AAGUID ${c.aaguid}; credential ${short(c.credentialId)} (${clientText(c.client)})`,
      );
      return;
    }
    case "signed": {
      const s = event.signature;
      const tags = [s.desktop ? "desktop Chrome" : "", s.phone ? "phone" : "", s.deployed ? "deployed" : "local"].filter(Boolean);
      console.log(
        `[S6] signature VERIFIED over Writ hash ${s.hashHex} by ${s.authenticatorName} via ${s.attachment ?? "n/a"} ` +
          `(${clientText(s.client)}); UP=${s.flags.up ? 1 : 0} UV=${s.flags.uv ? 1 : 0} BE=${s.flags.be ? 1 : 0} BS=${s.flags.bs ? 1 : 0}; ` +
          `counter ${s.counter}; origin ${s.origin} [${tags.join(", ")}]`,
      );
      return;
    }
    case "tamper": {
      const t = event.check;
      console.log(
        `[S6] tamper check ${t.ok ? "OK" : "FAILED"}: tampered Writ ${t.tamperedRejected ? "rejected" : "VERIFIED (bad)"}, ` +
          `forged clientDataJSON ${t.forgedRejected ? "rejected" : "VERIFIED (bad)"}, original ${t.controlVerified ? "verified" : "REJECTED (bad)"}`,
      );
      return;
    }
    case "rejected":
      console.log(`[S6] ${event.stage} rejected: ${event.error}`);
      return;
  }
}

async function buildApp(args: Args): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Explicit origins so APP_BASE_URL / GATEWAY_BASE_URL from .env cannot leak into a local run;
  // the plugin adds the loopback origin of each request itself.
  await app.register(passkeySpikePlugin, { rpID: args.rpID, origins: args.origins, onEvent: printEvent });
  await app.ready();
  return app;
}

async function fetchReport(app: FastifyInstance): Promise<PasskeySpikeReport> {
  const res = await app.inject({ method: "GET", url: `${PASSKEY_SPIKE_PREFIX}/report` });
  if (res.statusCode !== 200) throw new Error(`report endpoint returned HTTP ${res.statusCode}`);
  return res.json<PasskeySpikeReport>();
}

function printReport(report: PasskeySpikeReport): void {
  console.log("");
  console.log(`S6 verdict: ${report.verdict}`);
  if (report.missing.length > 0) {
    console.log("Missing:");
    for (const item of report.missing) console.log(`  - ${item}`);
    console.log(
      'Fallback (plan §17 S6): if passkeys cannot close this inside the time box, use an Ed25519 device key (WebCrypto) labeled "device key".',
    );
  }
  console.log("");
  console.log("---- paste into docs/SPIKES.md under '## S6 — Passkeys' ----");
  console.log(report.markdown);
  console.log("---- end ----");
}

async function selfTest(args: Args): Promise<void> {
  const app = await buildApp(args);
  try {
    const page = await app.inject({ method: "GET", url: PASSKEY_SPIKE_PREFIX });
    if (page.statusCode !== 200 || !page.body.includes("noindex")) throw new Error(`page check failed: HTTP ${page.statusCode}`);
    const res = await app.inject({ method: "POST", url: `${PASSKEY_SPIKE_PREFIX}/sign/options`, payload: {} });
    const body = res.json<{ writ: unknown; challenge: string; hashHex: string; options: { challenge: string; rpId?: string } }>();
    const recomputed = toBase64Url(hashJcs(body.writ));
    if (res.statusCode !== 200 || body.challenge !== recomputed || body.options.challenge !== recomputed) {
      throw new Error("challenge is not base64url(SHA-256(JCS(writ)))");
    }
    console.log(`self-test OK: page served with noindex; challenge ${body.challenge} = SHA-256(JCS(Writ)) ${body.hashHex}; RP ID ${body.options.rpId ?? "n/a"}`);
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  const parsed = parseCli(process.argv.slice(2));
  if (parsed === "help") {
    console.log(USAGE);
    return;
  }
  const args = parsed;
  if (args.selfTest) {
    await selfTest(args);
    return;
  }

  console.log("Spike S6: passkey signing over a Writ hash (plan §17). SPIKE ONLY: passkeys and results live in memory.");
  console.log(`env: ${describeEnv(["WEBAUTHN_RP_ID", "WEBAUTHN_RP_NAME", "SPIKE_PASSKEY_PORT"])}`);
  const envRpId = optionalEnv("WEBAUTHN_RP_ID");
  if (envRpId !== undefined && envRpId !== args.rpID) {
    console.log(`note: WEBAUTHN_RP_ID=${envRpId} from the environment is not used here; this run uses RP ID "${args.rpID}".`);
  }

  const app = await buildApp(args);
  try {
    await app.listen({ host: "127.0.0.1", port: args.port });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    throw new Error(
      code === "EADDRINUSE" ? `port ${args.port} is in use; pass --port or set SPIKE_PASSKEY_PORT` : `listen failed: ${String(error)}`,
      { cause: error },
    );
  }
  const pageUrl = args.rpID === "localhost" ? `http://localhost:${args.port}${PASSKEY_SPIKE_PREFIX}` : `${args.origins[0]}${PASSKEY_SPIKE_PREFIX}`;

  console.log("");
  console.log(`Listening on 127.0.0.1:${args.port}, RP ID "${args.rpID}".`);
  console.log(`Open: ${pageUrl}`);
  console.log("");
  console.log("WebAuthn needs a secure context: http://localhost is fine, a LAN IP over http (http://192.168.x.x) is not,");
  console.log("and 127.0.0.1 does not match RP ID \"localhost\". Use the URL above exactly.");
  console.log("");
  console.log("1. Desktop Chrome, platform authenticator (Windows Hello / Touch ID):");
  console.log('   "Create on this device" -> "Prepare Writ for signing" (this device) -> "Sign with passkey" -> PASS -> "Verify against a tampered Writ" -> FAIL as expected.');
  console.log("2. Phone via QR (hybrid), Bluetooth on for both devices:");
  console.log('   "Create on a phone (QR)" (or "Use a phone or tablet" in Chrome\'s dialog), scan the QR code with the phone camera,');
  console.log('   then "Prepare" with "a phone (QR)" -> "Sign with passkey" and approve on the phone.');
  console.log("3. Render (this is what S6 PASS needs): deploy the gateway with ENABLE_SPIKES=true and");
  console.log("   WEBAUTHN_RP_ID=<service>.onrender.com (the exact host: onrender.com is a public suffix), then open");
  console.log(`   https://<service>.onrender.com${PASSKEY_SPIKE_PREFIX} and repeat 1 and 2 (or open that URL on the phone directly).`);
  console.log("   Copy the markdown from section 5 of that page into docs/SPIKES.md, then set ENABLE_SPIKES back to false.");
  console.log("");
  console.log('Press Enter for the current verdict, "q" + Enter or Ctrl+C to stop.');
  console.log("");

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      const report = await fetchReport(app);
      printReport(report);
      console.log(`saved ${writeOut(OUT_FILE, report)}`);
    } finally {
      await app.close();
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      if (line.trim().toLowerCase() === "q") {
        rl.close();
        void stop();
        return;
      }
      void fetchReport(app).then(printReport, (error: unknown) => console.error(`report failed: ${String(error)}`));
    });
  }
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`error: ${error.message}\n`);
    console.error(USAGE);
    process.exit(2);
  }
  console.error(`Spike S6 failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
