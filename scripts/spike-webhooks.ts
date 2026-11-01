// Spike S3 (plan §17): do PayPal webhooks reach the gateway on Render and verify? Real sandbox calls
// only; prints every webhook id, event id and PayPal-Debug-Id, a verdict and a markdown block for
// docs/SPIKES.md.
//
//   pnpm spike spike-webhooks.ts list                         webhooks registered on the sandbox app
//   pnpm spike spike-webhooks.ts register [--url <listener>]  subscribe the gateway (prints PAYPAL_WEBHOOK_ID)
//   pnpm spike spike-webhooks.ts simulate --type <EVENT>      mock delivery (reachability only, see below)
//   pnpm spike spike-webhooks.ts events [--type <EVENT>]      real events PayPal generated for this app
//   pnpm spike spike-webhooks.ts resend --event-id <id>       re-deliver a REAL event (verifiable)
//   pnpm spike spike-webhooks.ts check [--url <gateway>]      health, fail-closed probe, verified deliveries -> verdict
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  consoleLogger,
  createPayPalHttp,
  createWebhook,
  buildCreateWebhookRequest,
  buildSimulateEventRequest,
  listWebhookEvents,
  listWebhooks,
  MOCK_WEBHOOK_ID,
  PayPalApiError,
  PayPalConfigError,
  resendWebhookEvent,
  simulateEvent,
  webhookResourceId,
  WRIT_WEBHOOK_EVENT_TYPES,
  type PayPalHttp,
  type PayPalLogEntry,
} from "@writ/paypal";
import { z } from "zod";
import { describeEnv, optionalEnv } from "./lib/env";
import { writeOut } from "./lib/out";

const LISTENER_PATH = "/v1/webhooks/paypal";
const RECENT_PATH = "/spikes/webhooks/recent";
const PAYPAL_ENV_NAMES = ["PAYPAL_ENV", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "GATEWAY_BASE_URL"] as const;

const SIMULATOR_NOTE =
  "Simulator (mock) events can NOT pass verification: PayPal signs them for the literal webhook id " +
  `"${MOCK_WEBHOOK_ID}" and documents that "postback verification to the verify-webhook-signature endpoint ` +
  'is not supported for mock events". The gateway therefore answers 400 and logs "verification FAILURE" ' +
  "for them (PayPal then retries the mock a few times). A mock proves reachability only; S3 needs a REAL event.";

const PASS_HOWTO = `How S3 shows PASS for a REAL event:
  1. Trigger one: "pnpm spike spike-vault.ts capture" (emits PAYMENT.AUTHORIZATION.CREATED and
     PAYMENT.CAPTURE.COMPLETED), or "resend --event-id <id>" with an id from "events".
  2. Render dashboard > writ-gateway > Logs: a JSON line with
       "msg":"paypal webhook verification SUCCESS"
       "webhook":{"event_id":"WH-...","event_type":"PAYMENT.CAPTURE.COMPLETED","resource_id":"<capture id>",
                  "verification_status":"SUCCESS","paypal_debug_id":"..."}
     plus a "paypal exchange" line for POST /v1/notifications/verify-webhook-signature with its debug_id.
  3. "pnpm spike spike-webhooks.ts check" reads the same deliveries from ${RECENT_PATH}
     (ENABLE_SPIKES=true) and prints PASS with the ids for docs/SPIKES.md.`;

const USAGE = `Spike S3: webhooks reach Render and verify (plan §17)

Usage: pnpm spike spike-webhooks.ts <command> [options]

Commands:
  list                       List webhooks on the sandbox REST app
  register [--url <url>]     Subscribe <url> (default \${GATEWAY_BASE_URL}${LISTENER_PATH}) to the plan §7
                             events and print the webhook id for PAYPAL_WEBHOOK_ID (re-uses an existing one)
  simulate --type <EVENT>    Ask PayPal's simulator to send a mock event to the webhook
                             (--webhook-id, default PAYPAL_WEBHOOK_ID). Reachability only.
  events [--type <EVENT>]    List recent real events PayPal generated for this app (--page-size, default 10)
  resend --event-id <id>     Re-deliver a real event to the webhook (--webhook-id, default PAYPAL_WEBHOOK_ID)
  check [--url <gateway>]    GET /healthz, POST an unsigned event (must be rejected), read verified
                             deliveries from ${RECENT_PATH}; prints the S3 verdict and markdown

Options:
  --dry-run                  register/simulate: print the request body; no PayPal calls
  -h, --help                 Show this help

${SIMULATOR_NOTE}

${PASS_HOWTO}`;

class UsageError extends Error {}

const COMMANDS = ["list", "register", "simulate", "events", "resend", "check"] as const;
type Command = (typeof COMMANDS)[number];

interface Args {
  command: Command;
  url: string | undefined;
  type: string | undefined;
  webhookId: string | undefined;
  eventId: string | undefined;
  pageSize: number;
  dryRun: boolean;
}

function parseCli(argv: string[]): Args | "help" {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        url: { type: "string" },
        type: { type: "string" },
        "webhook-id": { type: "string" },
        "event-id": { type: "string" },
        "page-size": { type: "string" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help === true) return "help";
  const [command, ...rest] = parsed.positionals;
  if (command === undefined) throw new UsageError(`missing command: ${COMMANDS.join(", ")}`);
  if (!(COMMANDS as readonly string[]).includes(command)) throw new UsageError(`unknown command "${command}"`);
  if (rest.length > 0) throw new UsageError(`unexpected arguments: ${rest.join(" ")}`);
  const rawPageSize = parsed.values["page-size"];
  const pageSize = rawPageSize === undefined ? 10 : Number(rawPageSize);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 300) throw new UsageError("--page-size must be 1-300");
  return {
    command: command as Command,
    url: parsed.values.url,
    type: parsed.values.type,
    webhookId: parsed.values["webhook-id"],
    eventId: parsed.values["event-id"],
    pageSize,
    dryRun: parsed.values["dry-run"] === true,
  };
}

// ---------------------------------------------------------------------------------------------

interface Session {
  readonly http: PayPalHttp;
  readonly exchanges: PayPalLogEntry[];
}

function openSession(): Session {
  const exchanges: PayPalLogEntry[] = [];
  const http = createPayPalHttp(process.env, {
    logger: (entry) => {
      exchanges.push(entry);
      consoleLogger(entry);
    },
  });
  console.log(`PayPal sandbox ${http.config.baseUrl}  ${describeEnv(PAYPAL_ENV_NAMES)}\n`);
  return { http, exchanges };
}

function gatewayBase(explicit: string | undefined): string {
  const raw = explicit ?? optionalEnv("GATEWAY_BASE_URL");
  if (raw === undefined) throw new UsageError("pass --url or set GATEWAY_BASE_URL (e.g. https://writ-gateway.onrender.com)");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`not an absolute URL: ${raw}`);
  }
  return url.origin;
}

function listenerUrl(explicit: string | undefined): string {
  if (explicit !== undefined) {
    // Accept either the gateway base or the full listener URL.
    let url: URL;
    try {
      url = new URL(explicit);
    } catch {
      throw new UsageError(`not an absolute URL: ${explicit}`);
    }
    return url.pathname === "/" || url.pathname === "" ? `${url.origin}${LISTENER_PATH}` : url.toString();
  }
  return `${gatewayBase(undefined)}${LISTENER_PATH}`;
}

function webhookIdOrThrow(explicit: string | undefined): string {
  const id = explicit ?? optionalEnv("PAYPAL_WEBHOOK_ID");
  if (id === undefined) throw new UsageError('pass --webhook-id or set PAYPAL_WEBHOOK_ID (run "register" first)');
  return id;
}

function printMarkdown(lines: readonly string[]): void {
  console.log("\n----- paste into docs/SPIKES.md -----8<-----");
  console.log(lines.join("\n"));
  console.log("----->8-----\n");
}

function code(text: string | null | undefined): string {
  return text === null || text === undefined ? "-" : `\`${text}\``;
}

// ---------------------------------------------------------------------------------------------
// Commands

async function runList(): Promise<number> {
  const { http } = openSession();
  const response = await listWebhooks(http);
  const webhooks = response.data.webhooks ?? [];
  if (webhooks.length === 0) console.log("No webhooks registered on this app yet. Run \"register\".");
  for (const w of webhooks) {
    console.log(`${w.id}  ${w.url}`);
    console.log(`  events: ${(w.event_types ?? []).map((e) => e.name).join(", ") || "(none)"}`);
  }
  console.log(`\nPayPal-Debug-Id ${response.debugId ?? "none"}`);
  return 0;
}

async function runRegister(args: Args): Promise<number> {
  const url = listenerUrl(args.url);
  const body = buildCreateWebhookRequest({ url, eventTypes: WRIT_WEBHOOK_EVENT_TYPES });
  if (args.dryRun) {
    console.log(`POST /v1/notifications/webhooks\n${JSON.stringify(body, null, 2)}`);
    return 0;
  }
  const { http, exchanges } = openSession();
  const existing = await listWebhooks(http);
  const match = (existing.data.webhooks ?? []).find((w) => w.url === url);
  let webhookId: string;
  let debugId: string | null;
  let created: boolean;
  if (match !== undefined) {
    webhookId = match.id;
    debugId = existing.debugId;
    created = false;
    const subscribed = new Set((match.event_types ?? []).map((e) => e.name));
    const missing = WRIT_WEBHOOK_EVENT_TYPES.filter((name) => !subscribed.has(name) && !subscribed.has("*"));
    console.log(`Webhook for ${url} already exists: ${webhookId}`);
    if (missing.length > 0) console.warn(`  Not subscribed to: ${missing.join(", ")} (edit it in the Developer Dashboard or delete and re-register)`);
  } else {
    const response = await createWebhook(http, { url, eventTypes: WRIT_WEBHOOK_EVENT_TYPES });
    webhookId = response.data.id;
    debugId = response.debugId;
    created = true;
    console.log(`Created webhook ${webhookId} for ${url}`);
  }
  console.log(`\nSet this on Render (writ-gateway > Environment) and in .env, then redeploy:\n\n  PAYPAL_WEBHOOK_ID=${webhookId}\n`);
  const path = writeOut("s3-webhook-register.json", {
    spike: "S3",
    step: "register",
    at: new Date().toISOString(),
    url,
    webhook_id: webhookId,
    created,
    event_types: WRIT_WEBHOOK_EVENT_TYPES,
    paypal_debug_id: debugId,
    paypal_exchanges: exchanges,
  });
  console.log(`Saved ${path}`);
  return 0;
}

async function runSimulate(args: Args): Promise<number> {
  if (args.type === undefined) throw new UsageError("simulate needs --type <EVENT>, e.g. PAYMENT.CAPTURE.COMPLETED");
  const webhookId = webhookIdOrThrow(args.webhookId);
  const body = buildSimulateEventRequest({ eventType: args.type, webhookId });
  console.log(`${SIMULATOR_NOTE}\n`);
  if (args.dryRun) {
    console.log(`POST /v1/notifications/simulate-event\n${JSON.stringify(body, null, 2)}`);
    return 0;
  }
  const { http } = openSession();
  const response = await simulateEvent(http, { eventType: args.type, webhookId, requestId: `wh-simulate:${randomUUID()}` });
  console.log(`Simulated ${response.data.event_type} as event ${response.data.id} (resource ${webhookResourceId(response.data) ?? "-"})`);
  console.log(`PayPal-Debug-Id ${response.debugId ?? "none"}`);
  console.log('\nExpected in the Render log: "paypal webhook verification FAILURE" for this event id. That is not the S3 verdict.');
  return 0;
}

async function runEvents(args: Args): Promise<number> {
  const { http } = openSession();
  const response = await listWebhookEvents(http, { pageSize: args.pageSize, ...(args.type === undefined ? {} : { eventType: args.type }) });
  const events = response.data.events ?? [];
  if (events.length === 0) console.log("No events yet. Run spike-vault.ts capture to generate real payment events.");
  for (const e of events) console.log(`${e.id}  ${e.create_time ?? "-"}  ${e.event_type}  resource ${webhookResourceId(e) ?? "-"}`);
  console.log(`\nPayPal-Debug-Id ${response.debugId ?? "none"}`);
  if (events.length > 0) console.log('Re-deliver one with: pnpm spike spike-webhooks.ts resend --event-id <id>');
  return 0;
}

async function runResend(args: Args): Promise<number> {
  if (args.eventId === undefined) throw new UsageError("resend needs --event-id <id> (see the events command)");
  const webhookId = webhookIdOrThrow(args.webhookId);
  const { http } = openSession();
  const response = await resendWebhookEvent(http, { eventId: args.eventId, webhookIds: [webhookId], requestId: `wh-resend:${randomUUID()}` });
  console.log(`Resent ${response.data.event_type} ${response.data.id} to webhook ${webhookId}. PayPal-Debug-Id ${response.debugId ?? "none"}`);
  console.log('Then run "check" (or look for "paypal webhook verification SUCCESS" in the Render log).');
  return 0;
}

const DeliverySchema = z.looseObject({
  received_at: z.string(),
  outcome: z.string(),
  event_id: z.string().nullable(),
  event_type: z.string().nullable(),
  resource_id: z.string().nullable(),
  transmission_id: z.string().nullable(),
  verification_status: z.string().nullable(),
  paypal_debug_id: z.string().nullable(),
  reason: z.string().nullable(),
});
const RecentSchema = z.looseObject({ deliveries: z.array(DeliverySchema) });
type Delivery = z.output<typeof DeliverySchema>;

async function httpCall(url: string, init: RequestInit = {}): Promise<{ status: number; text: string } | { error: string }> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: "manual" });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function runCheck(args: Args): Promise<number> {
  const base = gatewayBase(args.url);
  const at = new Date().toISOString();
  console.log(`Gateway ${base}  ${describeEnv(["PAYPAL_WEBHOOK_ID"])}\n`);

  const health = await httpCall(`${base}/healthz`);
  const healthOk = "status" in health && health.status === 200;
  console.log(`  ${healthOk ? "PASS" : "FAIL"}  GET /healthz -> ${"status" in health ? `${health.status} ${health.text.slice(0, 120)}` : health.error}`);

  // An unsigned event must never be acknowledged (threat T11): any 2xx here is a FAIL.
  const probe = await httpCall(`${base}${LISTENER_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: `WH-SPIKE-PROBE-${randomUUID()}`, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "SPIKE-PROBE" } }),
  });
  const probeOk = "status" in probe && probe.status >= 400 && probe.status < 500;
  console.log(`  ${probeOk ? "PASS" : "FAIL"}  POST ${LISTENER_PATH} without PayPal signature headers -> ${"status" in probe ? probe.status : probe.error} (must be 4xx)`);

  const recentRaw = await httpCall(`${base}${RECENT_PATH}`);
  let deliveries: Delivery[] = [];
  let recentNote: string;
  if ("status" in recentRaw && recentRaw.status === 200) {
    let json: unknown;
    try {
      json = JSON.parse(recentRaw.text) as unknown;
    } catch {
      json = null;
    }
    const parsed = RecentSchema.safeParse(json);
    deliveries = parsed.success ? parsed.data.deliveries : [];
    recentNote = parsed.success ? `${deliveries.length} recent deliveries` : "unexpected response shape";
  } else {
    recentNote = `GET ${RECENT_PATH} -> ${"status" in recentRaw ? recentRaw.status : recentRaw.error} (set ENABLE_SPIKES=true on the gateway, or read the Render log)`;
  }
  console.log(`  info  ${recentNote}`);

  const verified = deliveries.filter((d) => d.outcome === "verified" && d.verification_status === "SUCCESS");
  const failed = deliveries.filter((d) => d.verification_status !== null && d.verification_status !== "SUCCESS");
  for (const d of deliveries.slice(0, 15)) {
    console.log(`    ${d.received_at}  ${d.outcome.padEnd(11)} ${d.event_type ?? "-"}  ${d.event_id ?? "-"}  status=${d.verification_status ?? "-"}  debug_id=${d.paypal_debug_id ?? "-"}`);
  }
  const verifiedOk = verified.length > 0;
  console.log(`  ${verifiedOk ? "PASS" : "FAIL"}  at least one real event verified SUCCESS by PayPal (${verified.length})`);

  const verdict = healthOk && probeOk && verifiedOk ? "PASS" : healthOk && probeOk ? "PENDING" : "FAIL";
  console.log(`\nS3: ${verdict}`);
  if (verdict === "PENDING") console.log(`\n${PASS_HOWTO}`);

  const path = writeOut("s3-webhooks.json", {
    spike: "S3",
    at,
    gateway: base,
    verdict,
    health: "status" in health ? { status: health.status } : health,
    unsigned_probe: "status" in probe ? { status: probe.status } : probe,
    verified_deliveries: verified,
    failed_verifications: failed,
    deliveries,
  });
  console.log(`Saved ${path}`);

  printMarkdown([
    `### S3 — webhooks reach Render and verify, ${at}`,
    "",
    `- **S3: ${verdict}.** Gateway \`${base}\`, listener \`${LISTENER_PATH}\`, webhook id ${code(optionalEnv("PAYPAL_WEBHOOK_ID"))}.`,
    `- \`GET /healthz\` -> ${"status" in health ? health.status : "error"}; unsigned POST -> ${"status" in probe ? probe.status : "error"} (rejected, fail closed).`,
    "- Verification: PayPal postback `POST /v1/notifications/verify-webhook-signature` with the raw event (numbers verbatim).",
    `- Simulator: mock events are not verifiable by postback (PayPal docs); they show as FAILURE and do not count.`,
    ...(verdict === "PASS" ? [] : ["- Fallback if red: polling job every 30 s against the PayPal API (plan §17 S3)."]),
    "",
    "| Received | Event type | Event id | Resource id | verification_status | PayPal-Debug-Id |",
    "|---|---|---|---|---|---|",
    ...[...verified, ...failed]
      .slice(0, 10)
      .map((d) => `| ${d.received_at} | ${d.event_type ?? "-"} | ${code(d.event_id)} | ${code(d.resource_id)} | ${d.verification_status ?? "-"} | ${code(d.paypal_debug_id)} |`),
  ]);
  return verdict === "PASS" ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const args = parseCli(argv);
  if (args === "help") {
    console.log(USAGE);
    return 0;
  }
  switch (args.command) {
    case "list":
      return runList();
    case "register":
      return runRegister(args);
    case "simulate":
      return runSimulate(args);
    case "events":
      return runEvents(args);
    case "resend":
      return runResend(args);
    case "check":
      return runCheck(args);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\nRun with --help for usage.`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof PayPalConfigError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    if (error instanceof PayPalApiError) {
      // §22 rule 43: report the exact response with its PayPal-Debug-Id.
      console.error(`PayPal error: ${error.message}`);
      if (error.details.length > 0) console.error(JSON.stringify(error.details, null, 2));
      process.exitCode = 1;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
