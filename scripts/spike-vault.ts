// Spikes S1 (Vault + merchant-initiated AUTHORIZE -> capture / void) and S8 (custom_id / invoice_id
// round-trip), plan §17. Real sandbox calls only; prints every PayPal ID and PayPal-Debug-Id, a
// PASS / FALLBACK verdict and a markdown block for docs/SPIKES.md.
//
//   pnpm spike spike-vault.ts setup     save the sandbox buyer's PayPal wallet (Vault v3, no purchase)
//   pnpm spike spike-vault.ts capture   AUTHORIZE $44.00 with the vault_id, capture it, check S8
//   pnpm spike spike-vault.ts void      AUTHORIZE $44.00 with the vault_id, void it
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  commitPost,
  commitPre,
  customIdMatches,
  invoiceIdMatches,
  sha256,
  toCustomId,
  toHex,
  toInvoiceId,
  ZERO_HASH,
} from "@writ/core";
import {
  AGENT_USAGE_PATTERN,
  AUTHORIZATION_STATUS,
  authorizeWithVault,
  buildCaptureRequest,
  buildMerchantInitiatedOrder,
  buildPayPalSetupTokenRequest,
  CAPTURE_STATUS,
  captureAuthorization,
  consoleLogger,
  createPaymentToken,
  createPayPalHttp,
  createSetupToken,
  getAuthorization,
  getCapture,
  getOrder,
  getSetupToken,
  MERCHANT_INITIATED_STORED_CREDENTIAL,
  moneyToMinor,
  PayPalApiError,
  PayPalConfigError,
  PayPalError,
  PayPalFlowError,
  purchaseRequestId,
  SETUP_TOKEN_STATUS,
  setupTokenApproveUrl,
  voidAuthorization,
  type MerchantInitiatedOrderInput,
  type Money,
  type PayPalHttp,
  type PayPalLogEntry,
} from "@writ/paypal";
import { z } from "zod";
import { describeEnv, optionalEnv } from "./lib/env";
import { OUT_DIR, readOut, writeOut } from "./lib/out";

const HERO_AMOUNT_MINOR = 4400n;
const HERO_CURRENCY = "USD" as const;
const HERO_ITEM = "Hand-thrown ceramic pour-over set";
const DEFAULT_PORT = 8787;
const DEFAULT_WAIT_MINUTES = 15;
const VAULT_FILE = "vault.json";
const PAYPAL_ENV_NAMES = ["PAYPAL_ENV", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"] as const;

const S1_FALLBACK =
  "**Supervised mode** (plan §17 S1): each purchase uses the buyer's PayPal approval; Writ still enforces everything; " +
  'the story says "automatic when Agent Ready enables it".';
const S8_FALLBACK = "`custom_id` only (plan §17 S8); the post-commitment C_post is kept in the ledger.";

// ---------------------------------------------------------------------------------------------
// Arguments

type Command = "setup" | "capture" | "void";
type OrderCommand = Exclude<Command, "setup">;

interface Args {
  readonly command: Command;
  readonly port: number;
  readonly storedCredential: boolean;
  readonly dryRun: boolean;
  readonly waitMinutes: number;
}

const USAGE = `Usage: pnpm spike spike-vault.ts <setup|capture|void> [options]

  setup     Create a Vault v3 setup token, open the approve URL as the sandbox PERSONAL buyer,
            then create the payment token (vault_id). Writes scripts/.out/${VAULT_FILE}.
  capture   Merchant-initiated AUTHORIZE of $44.00 with the vault_id, capture exactly $44.00 with
            final_capture and invoice_id, then verify custom_id / invoice_id round-trip (S8).
            Writes scripts/.out/s1-capture.json.
  void      Same AUTHORIZE, then void it and confirm VOIDED. Writes scripts/.out/s1-void.json.

Options:
  --port <n>                 Return-URL port for setup (default SPIKE_PORT or ${DEFAULT_PORT})
  --wait-min <n>             Minutes to wait for the buyer's approval (default ${DEFAULT_WAIT_MINUTES})
  --no-stored-credential     Send the order without payment_source.paypal.stored_credential (diagnosis only)
  --dry-run                  Print the request bodies; no PayPal calls, no credentials needed
  -h, --help                 Show this help

Needs .env: PAYPAL_ENV=sandbox, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (sandbox REST app with Vault enabled).`;

class UsageError extends Error {
  override readonly name = "UsageError";
}

function parsePositiveInt(name: string, raw: string | undefined, max: number): number {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) throw new UsageError(`${name} needs a whole number`);
  const value = Number(raw);
  if (value < 1 || value > max) throw new UsageError(`${name} must be between 1 and ${max}`);
  return value;
}

function parseArgs(argv: readonly string[], spikePort: string | undefined): Args | "help" {
  let command: Command | undefined;
  let port: number | undefined;
  let storedCredential = true;
  let dryRun = false;
  let waitMinutes = DEFAULT_WAIT_MINUTES;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = (): string | undefined => {
      if (inline !== undefined) return inline;
      i += 1;
      return argv[i];
    };
    switch (flag) {
      case "-h":
      case "--help":
        return "help";
      case "--port":
        port = parsePositiveInt("--port", value(), 65_535);
        break;
      case "--wait-min":
        waitMinutes = parsePositiveInt("--wait-min", value(), 120);
        break;
      case "--no-stored-credential":
        storedCredential = false;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "setup":
      case "capture":
      case "void":
        if (command !== undefined) throw new UsageError(`only one command allowed (got ${command} and ${flag})`);
        command = flag;
        break;
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  if (command === undefined) throw new UsageError("missing command: setup, capture or void");
  if (port === undefined) {
    const fromEnv = spikePort?.trim();
    port = fromEnv === undefined || fromEnv === "" ? DEFAULT_PORT : parsePositiveInt("SPIKE_PORT", fromEnv, 65_535);
  }
  return { command, port, storedCredential, dryRun, waitMinutes };
}

// ---------------------------------------------------------------------------------------------
// Recording and printing

interface Row {
  readonly step: string;
  readonly id: string | null;
  readonly status: string | null;
  readonly debugId: string | null;
}

interface Check {
  readonly spike: "S1" | "S8";
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
  /** Non-gating checks are recorded as evidence but do not decide the verdict. */
  readonly gating: boolean;
}

type Verdict = "PASS" | "FAIL" | "FALLBACK" | "NOT RUN";

class Recorder {
  readonly exchanges: PayPalLogEntry[] = [];
  readonly rows: Row[] = [];
  readonly checks: Check[] = [];

  readonly logger = (entry: PayPalLogEntry): void => {
    this.exchanges.push(entry);
    consoleLogger(entry);
  };

  row(step: string, id: string | null, status: string | null, debugId: string | null): void {
    this.rows.push({ step, id, status, debugId });
  }

  check(spike: Check["spike"], name: string, pass: boolean, detail: string, gating = true): boolean {
    this.checks.push({ spike, name, pass, detail, gating });
    console.log(`  ${pass ? "PASS" : gating ? "FAIL" : "info"}  [${spike}] ${name}${detail === "" ? "" : ` (${detail})`}`);
    return pass;
  }

  verdict(spike: Check["spike"]): Verdict {
    const gating = this.checks.filter((c) => c.spike === spike && c.gating);
    if (gating.length === 0) return "NOT RUN";
    return gating.every((c) => c.pass) ? "PASS" : "FAIL";
  }
}

interface Session {
  readonly http: PayPalHttp;
  readonly rec: Recorder;
}

function openSession(): Session {
  const rec = new Recorder();
  const http = createPayPalHttp(process.env, { logger: rec.logger });
  console.log(`PayPal sandbox ${http.config.baseUrl}  ${describeEnv(PAYPAL_ENV_NAMES)}`);
  return { http, rec };
}

/** Runs a PayPal call and hands back the error instead of throwing, so the step can report it. */
async function attempt<T>(call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, error };
  }
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function printTable(rows: readonly Row[]): void {
  const header: Row = { step: "step", id: "resource id", status: "status", debugId: "PayPal-Debug-Id" };
  const all = [header, ...rows];
  const width = (pick: (r: Row) => string | null) => Math.max(...all.map((r) => (pick(r) ?? "-").length));
  const [w1, w2, w3] = [width((r) => r.step), width((r) => r.id), width((r) => r.status)];
  console.log("");
  for (const r of all) console.log(`  ${pad(r.step, w1)}  ${pad(r.id ?? "-", w2)}  ${pad(r.status ?? "-", w3)}  ${r.debugId ?? "-"}`);
  console.log("");
}

function code(text: string | null): string {
  return text === null ? "-" : `\`${text}\``;
}

function markdownRows(rows: readonly Row[]): string[] {
  return [
    "| Step | Resource ID | Status | PayPal-Debug-Id |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.step} | ${code(r.id)} | ${r.status ?? "-"} | ${code(r.debugId)} |`),
  ];
}

function markdownChecks(checks: readonly Check[]): string[] {
  return [
    "| Spike | Check | Result | Detail |",
    "|---|---|---|---|",
    ...checks.map((c) => `| ${c.spike} | ${c.name} | ${c.pass ? "PASS" : c.gating ? "FAIL" : "info"} | ${c.detail.replaceAll("|", "\\|")} |`),
  ];
}

function printMarkdown(lines: readonly string[]): void {
  console.log("\n----- paste into docs/SPIKES.md -----8<-----");
  console.log(lines.join("\n"));
  console.log("----->8-----\n");
}

interface DescribedError {
  readonly text: string;
  readonly debugId: string | null;
  readonly json: Record<string, unknown>;
}

function describeError(error: unknown): DescribedError {
  if (error instanceof PayPalApiError) {
    return {
      text: `${error.status} ${error.name}${error.issues.length > 0 ? ` [${error.issues.join(", ")}]` : ""}: ${error.paypalMessage}`,
      debugId: error.debugId,
      json: {
        type: "PayPalApiError",
        method: error.method,
        path: error.path,
        status: error.status,
        name: error.name,
        message: error.paypalMessage,
        details: error.details,
        debug_id: error.debugId,
      },
    };
  }
  if (error instanceof PayPalFlowError) {
    return {
      text: error.message,
      debugId: error.debugId,
      json: { type: "PayPalFlowError", message: error.message, resource_id: error.resourceId, status: error.status, debug_id: error.debugId },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const debugId = error instanceof PayPalError && "debugId" in error && typeof error.debugId === "string" ? error.debugId : null;
  return { text: message, debugId, json: { type: error instanceof Error ? error.name : "unknown", message } };
}

function newRunId(): string {
  // base36 time + random hex: unique per run, so invoice_id (unique per merchant) never collides.
  return `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

function amountIs(money: Money | undefined, expected: bigint): { pass: boolean; detail: string } {
  if (money === undefined) return { pass: false, detail: "amount missing" };
  try {
    return { pass: moneyToMinor(money, HERO_CURRENCY) === expected, detail: `${money.currency_code} ${money.value}` };
  } catch (error) {
    return { pass: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------------------------
// Sample commitments (plan §6.7). The hashes stand in for H_w, H_c, H_p and H_verifier; the run id
// makes every C_post, and so every invoice_id, unique.

interface SampleCommitments {
  readonly writShort: string;
  readonly cPre: Uint8Array;
  readonly cPost: Uint8Array;
  readonly customId: string;
  readonly invoiceId: string;
}

function sampleCommitments(runId: string): SampleCommitments {
  const writShort = `s1${runId}`.slice(0, 16);
  const cPre = commitPre(
    sha256(`writ-spike-s1:${runId}:writ:pottery gift for my sister, under $60`),
    sha256(`writ-spike-s1:${runId}:cart:${HERO_ITEM}:${HERO_AMOUNT_MINOR}`),
    sha256(`writ-spike-s1:${runId}:policy:APPROVE`),
  );
  const cPost = commitPost(cPre, sha256(`writ-spike-s1:${runId}:verifier:APPROVE`), ZERO_HASH);
  return { writShort, cPre, cPost, customId: toCustomId(writShort, cPre), invoiceId: toInvoiceId(cPost) };
}

function orderInputFor(kind: OrderCommand, runId: string, vaultId: string, args: Args) {
  const purchaseId = `spike-s1-${kind}-${runId}`;
  const sample = sampleCommitments(runId);
  const input: MerchantInitiatedOrderInput = {
    purchaseId,
    amountMinor: HERO_AMOUNT_MINOR,
    currency: HERO_CURRENCY,
    itemName: HERO_ITEM,
    vaultId,
    customId: sample.customId,
    ...(args.storedCredential ? {} : { storedCredential: null }),
  };
  return { purchaseId, sample, input };
}

// ---------------------------------------------------------------------------------------------
// vault.json

const VaultFileSchema = z.looseObject({
  setup_token_id: z.string().min(1),
  payment_token_id: z.string().min(1),
  vault_id: z.string().min(1),
  customer_id: z.string().nullable(),
});
type VaultFile = z.output<typeof VaultFileSchema>;

function loadVaultFile(): VaultFile {
  const raw = readOut(VAULT_FILE);
  if (raw === undefined) {
    throw new UsageError(`${join(OUT_DIR, VAULT_FILE)} not found. Run "pnpm spike spike-vault.ts setup" first to save the sandbox buyer's wallet.`);
  }
  const parsed = VaultFileSchema.safeParse(raw);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new UsageError(`${join(OUT_DIR, VAULT_FILE)} is not a setup result (bad or missing: ${missing}). Re-run setup.`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Return-URL server for the buyer's approval

interface ReturnEvent {
  readonly kind: "return" | "cancel";
  readonly query: Readonly<Record<string, string>>;
}

interface ReturnServer {
  wait(minutes: number): Promise<ReturnEvent>;
  close(): Promise<void>;
}

function listen(server: Server, port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      // IPv6 loopback may be absent; 127.0.0.1 alone is enough then.
      if (host === "::1" && (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT")) resolve(false);
      else if (error.code === "EADDRINUSE") reject(new UsageError(`port ${port} is in use on ${host}; pass --port or set SPIKE_PORT`));
      else reject(error);
    });
    server.listen(port, host, () => resolve(true));
  });
}

async function startReturnServer(port: number): Promise<ReturnServer> {
  let deliver: (event: ReturnEvent) => void = () => undefined;
  const received = new Promise<ReturnEvent>((resolve) => {
    deliver = resolve;
  });
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (req.method !== "GET" || (url.pathname !== "/return" && url.pathname !== "/cancel")) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    const kind = url.pathname === "/return" ? "return" : "cancel";
    const text = kind === "return" ? "PayPal approval received." : "PayPal approval cancelled.";
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(`<!doctype html><meta charset="utf-8"><title>Writ spike S1</title><p>${text} You can close this tab and return to the terminal.</p>`);
    deliver({ kind, query: Object.fromEntries(url.searchParams) });
  };
  // Loopback only: browsers resolve the http://localhost return URL to 127.0.0.1 or ::1.
  const v4 = createServer(handler);
  const v6 = createServer(handler);
  await listen(v4, port, "127.0.0.1");
  const live = (await listen(v6, port, "::1")) ? [v4, v6] : [v4];
  return {
    async wait(minutes) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${minutes} min waiting for the buyer to approve`)), minutes * 60_000);
      });
      try {
        return await Promise.race([received, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      await Promise.all(live.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// setup

function setupBody(port: number) {
  return buildPayPalSetupTokenRequest({
    returnUrl: `http://localhost:${port}/return`,
    cancelUrl: `http://localhost:${port}/cancel`,
    brandName: "Writ (sandbox)",
    description: "Writ agents pay only inside limits you sign",
  });
}

function dryRunSetup(args: Args): number {
  const runId = newRunId();
  console.log(`POST /v3/vault/setup-tokens  PayPal-Request-Id: spike-s1-${runId}:setup-token`);
  console.log(JSON.stringify(setupBody(args.port), null, 2));
  console.log(`\nthen, after the buyer approves at the "approve" link:\nPOST /v3/vault/payment-tokens  PayPal-Request-Id: spike-s1-${runId}:payment-token`);
  console.log(JSON.stringify({ payment_source: { token: { id: "<setup_token_id>", type: "SETUP_TOKEN" } } }, null, 2));
  return 0;
}

async function runSetup(args: Args, { http, rec }: Session): Promise<number> {
  const runId = newRunId();
  const body = setupBody(args.port);
  const returnUrl = body.payment_source.paypal.experience_context.return_url;
  const server = await startReturnServer(args.port);
  try {
    const setup = await attempt(() => createSetupToken(http, body, { requestId: `spike-s1-${runId}:setup-token` }));
    if (!setup.ok) return reportSetupFailure(rec, setup.error, "create setup token");
    const token = setup.value;
    rec.row("POST /v3/vault/setup-tokens", token.data.id, token.data.status, token.debugId);
    console.log("\n1. Open this URL in a browser and log in as the sandbox PERSONAL buyer (not the business account):\n");
    console.log(`   ${setupTokenApproveUrl(token.data)}\n`);
    console.log(`2. Approve. PayPal redirects to ${returnUrl}; this script listens there for up to ${args.waitMinutes} min.\n`);

    const event = await server.wait(args.waitMinutes);
    const queryKeys = Object.keys(event.query);
    console.log(`Buyer ${event.kind === "return" ? "returned" : "cancelled"}; return URL query keys: ${queryKeys.join(", ") || "(none)"}`);
    if (event.kind === "cancel") {
      rec.row("buyer approval", token.data.id, "CANCELLED", null);
      printTable(rec.rows);
      console.log("The buyer cancelled. Run setup again and approve.");
      return 1;
    }

    const after = await getSetupToken(http, token.data.id);
    rec.row("GET /v3/vault/setup-tokens/{id}", after.data.id, after.data.status, after.debugId);
    if (after.data.status !== SETUP_TOKEN_STATUS.APPROVED) {
      console.warn(`Setup token is ${after.data.status}, expected APPROVED; creating the payment token anyway to record PayPal's answer.`);
    }

    const payment = await attempt(() => createPaymentToken(http, token.data.id, { requestId: `spike-s1-${runId}:payment-token` }));
    if (!payment.ok) {
      printTable(rec.rows);
      return reportSetupFailure(rec, payment.error, "create payment token");
    }
    const pt = payment.value;
    rec.row("POST /v3/vault/payment-tokens", pt.data.id, "VAULTED", pt.debugId);
    printTable(rec.rows);

    const customerId = pt.data.customer?.id ?? after.data.customer?.id ?? token.data.customer?.id ?? null;
    const createdAt = new Date().toISOString();
    const path = writeOut(VAULT_FILE, {
      spike: "S1",
      step: "setup",
      run_id: runId,
      created_at: createdAt,
      setup_token_id: token.data.id,
      setup_status_after_return: after.data.status,
      payment_token_id: pt.data.id,
      vault_id: pt.data.id,
      customer_id: customerId,
      payer_id: pt.data.payment_source?.paypal?.payer_id ?? null,
      usage_pattern: AGENT_USAGE_PATTERN,
      return_query: event.query,
      debug_ids: { create_setup_token: token.debugId, get_setup_token: after.debugId, create_payment_token: pt.debugId },
      paypal_exchanges: rec.exchanges,
    });
    console.log(`Saved ${path}`);
    console.log(`vault_id (payment token) = ${pt.data.id}; PayPal customer id = ${customerId ?? "(none returned)"}`);

    printMarkdown([
      `### S1a — Save PayPal without purchase (Vault v3), run \`${runId}\`, ${createdAt}`,
      "",
      `- Result: **vault_id \`${pt.data.id}\`** from setup token \`${token.data.id}\`; PayPal customer \`${customerId ?? "-"}\`.`,
      `- Setup token: \`usage_type: MERCHANT\`, \`customer_type: CONSUMER\`, \`usage_pattern: ${AGENT_USAGE_PATTERN}\`, \`permit_multiple_payment_tokens: false\`.`,
      `- Status after buyer approval: \`${after.data.status}\`. Return URL query keys: ${queryKeys.map((k) => `\`${k}\``).join(", ") || "none"}.`,
      "- Decision: save-without-purchase (setup token -> payment token); no $1 save-with-purchase needed.",
      "",
      ...markdownRows(rec.rows),
    ]);
    return 0;
  } finally {
    await server.close();
  }
}

function reportSetupFailure(rec: Recorder, error: unknown, what: string): number {
  const described = describeError(error);
  console.error(`\nFailed to ${what}: ${described.text} (PayPal-Debug-Id ${described.debugId ?? "none"})`);
  console.error("Check the sandbox REST app: Apps & Credentials > (app) > Features > Accept payments > Advanced options > Vault.");
  const path = writeOut("vault-error.json", { spike: "S1", step: "setup", failed: what, error: described.json, paypal_exchanges: rec.exchanges });
  console.log(`Saved ${path}`);
  printMarkdown([
    `### S1a — Save PayPal without purchase — FAILED (${what})`,
    "",
    `- PayPal error: \`${described.text}\` (PayPal-Debug-Id \`${described.debugId ?? "none"}\`).`,
    "- Check Vault is enabled on the sandbox app (Features > Accept payments > Advanced options), then re-run setup.",
    `- If Vault cannot be enabled: S1 fallback, ${S1_FALLBACK}`,
    "",
    ...markdownRows(rec.rows),
  ]);
  return 1;
}

// ---------------------------------------------------------------------------------------------
// capture and void

function dryRunOrderFlow(kind: OrderCommand, args: Args): number {
  const runId = newRunId();
  const vaultId = readOut(VAULT_FILE) === undefined ? "DRY_RUN_VAULT_ID" : loadVaultFile().vault_id;
  const { purchaseId, sample, input } = orderInputFor(kind, runId, vaultId, args);
  console.log(`POST /v2/checkout/orders  PayPal-Request-Id: ${purchaseRequestId(purchaseId, "authorize")}  Prefer: return=representation`);
  console.log(JSON.stringify(buildMerchantInitiatedOrder(input), null, 2));
  console.log(`\n(only if the order comes back CREATED/APPROVED) POST /v2/checkout/orders/<order_id>/authorize  PayPal-Request-Id: ${purchaseRequestId(purchaseId, "order-authorize")}  body {}`);
  if (kind === "capture") {
    console.log(`\nPOST /v2/payments/authorizations/<authorization_id>/capture  PayPal-Request-Id: ${purchaseRequestId(purchaseId, "capture")}`);
    console.log(JSON.stringify(buildCaptureRequest({ amountMinor: HERO_AMOUNT_MINOR, currency: HERO_CURRENCY, invoiceId: sample.invoiceId }), null, 2));
  } else {
    console.log(`\nPOST /v2/payments/authorizations/<authorization_id>/void  PayPal-Request-Id: ${purchaseRequestId(purchaseId, "void")}  (no body)`);
  }
  console.log(`\nwrit_short ${sample.writShort}\nC_pre      ${toHex(sample.cPre)}\nC_post     ${toHex(sample.cPost)}`);
  return 0;
}

async function runOrderFlow(kind: OrderCommand, args: Args, vault: VaultFile, { http, rec }: Session): Promise<number> {
  const runId = newRunId();
  const { purchaseId, sample, input } = orderInputFor(kind, runId, vault.vault_id, args);
  const outFile = kind === "capture" ? "s1-capture.json" : "s1-void.json";
  const createdAt = new Date().toISOString();
  const base = {
    spike: kind === "capture" ? "S1+S8" : "S1",
    step: kind,
    run_id: runId,
    created_at: createdAt,
    purchase_id: purchaseId,
    vault_id: vault.vault_id,
    amount_minor: HERO_AMOUNT_MINOR.toString(),
    currency: HERO_CURRENCY,
    item_name: HERO_ITEM,
    stored_credential: args.storedCredential ? MERCHANT_INITIATED_STORED_CREDENTIAL : null,
    writ_short: sample.writShort,
    c_pre_hex: toHex(sample.cPre),
    c_post_hex: toHex(sample.cPost),
    custom_id: sample.customId,
    invoice_id: kind === "capture" ? sample.invoiceId : null,
  };

  console.log(`\nS1 ${kind}: merchant-initiated AUTHORIZE ${HERO_CURRENCY} 44.00 with vault_id ${vault.vault_id}`);
  console.log(`  purchase_id ${purchaseId}\n  custom_id   ${sample.customId}${kind === "capture" ? `\n  invoice_id  ${sample.invoiceId}` : ""}\n`);

  const authorized = await attempt(() => authorizeWithVault(http, input));
  if (!authorized.ok) return reportAuthorizeFallback(rec, authorized.error, base, outFile, args);
  const auth = authorized.value;
  const authorization = auth.authorization;
  rec.row(
    "POST /v2/checkout/orders (AUTHORIZE, vault_id)",
    auth.order.id,
    auth.createdStatus,
    auth.debugIds.createOrder,
  );
  if (auth.flow === "order-authorize") rec.row("POST /v2/checkout/orders/{id}/authorize", auth.order.id, auth.order.status, auth.debugIds.authorizeOrder);
  rec.row("authorization (from order)", authorization.id, authorization.status, null);

  rec.check("S1", "order intent is AUTHORIZE", auth.order.intent === "AUTHORIZE", `intent ${auth.order.intent ?? "(not echoed)"}, flow ${auth.flow}`);
  const createdOk = rec.check("S1", "authorization CREATED (funds held)", authorization.status === AUTHORIZATION_STATUS.CREATED, `status ${authorization.status}`);
  const held = amountIs(authorization.amount, HERO_AMOUNT_MINOR);
  const heldOk = rec.check("S1", "authorized amount is exactly 44.00", held.pass, held.detail);

  const ids: { order_id: string; authorization_id: string; capture_id: string | null } = {
    order_id: auth.order.id,
    authorization_id: authorization.id,
    capture_id: null,
  };
  const debugIds: Record<string, string | null> = { create_order: auth.debugIds.createOrder, authorize_order: auth.debugIds.authorizeOrder };

  if (kind === "void" || !createdOk || !heldOk) {
    // §22 rule 11: never capture anything but the verified amount; release the hold instead.
    if (kind === "capture") console.warn("Not capturing: the authorization is not exactly what was verified. Voiding it instead.");
    const voided = await voidAuthorization(http, { authorizationId: authorization.id, purchaseId });
    debugIds.void = voided.debugId;
    rec.row("POST /v2/payments/authorizations/{id}/void", authorization.id, voided.data?.status ?? `HTTP ${voided.status}`, voided.debugId);
    const reread = await getAuthorization(http, authorization.id);
    debugIds.get_authorization = reread.debugId;
    rec.row("GET /v2/payments/authorizations/{id}", reread.data.id, reread.data.status, reread.debugId);
    rec.check("S1", "authorization VOIDED after void", reread.data.status === AUTHORIZATION_STATUS.VOIDED, `status ${reread.data.status}`, kind === "void");
  } else {
    const capture = await captureAuthorization(http, {
      authorizationId: authorization.id,
      purchaseId,
      amountMinor: HERO_AMOUNT_MINOR,
      currency: HERO_CURRENCY,
      invoiceId: sample.invoiceId,
    });
    ids.capture_id = capture.data.id;
    debugIds.capture = capture.debugId;
    rec.row("POST /v2/payments/authorizations/{id}/capture", capture.data.id, capture.data.status, capture.debugId);
    const reason = capture.data.status_details?.reason;
    rec.check("S1", "capture COMPLETED", capture.data.status === CAPTURE_STATUS.COMPLETED, `status ${capture.data.status}${reason ? ` (${reason})` : ""}`);
    const captured = amountIs(capture.data.amount, HERO_AMOUNT_MINOR);
    rec.check("S1", "captured amount is exactly 44.00", captured.pass, captured.detail);
    rec.check("S1", "final_capture is true", capture.data.final_capture === true, `final_capture ${String(capture.data.final_capture)}`);

    const capRead = await getCapture(http, capture.data.id);
    debugIds.get_capture = capRead.debugId;
    rec.row("GET /v2/payments/captures/{id}", capRead.data.id, capRead.data.status, capRead.debugId);
    const invoice = capRead.data.invoice_id ?? null;
    rec.check("S8", "GET capture: invoice_id round-trips exactly", invoice === sample.invoiceId, `got ${invoice ?? "(missing)"}`);
    rec.check("S8", "invoice_id verifies against C_post", invoice !== null && invoiceIdMatches(invoice, sample.cPost), "invoiceIdMatches");
    rec.check("S8", "GET capture: custom_id carried from the order", capRead.data.custom_id === sample.customId, `got ${capRead.data.custom_id ?? "(missing)"}`, false);
    const related = capRead.data.supplementary_data?.related_ids;
    rec.check(
      "S1",
      "capture links back to order and authorization",
      related?.order_id === auth.order.id && related.authorization_id === authorization.id,
      `related_ids ${JSON.stringify(related ?? null)}`,
      false,
    );

    const authRead = await getAuthorization(http, authorization.id);
    debugIds.get_authorization = authRead.debugId;
    rec.row("GET /v2/payments/authorizations/{id}", authRead.data.id, authRead.data.status, authRead.debugId);
    rec.check("S1", "authorization CAPTURED after capture", authRead.data.status === AUTHORIZATION_STATUS.CAPTURED, `status ${authRead.data.status}`);
  }
  const captured = ids.capture_id !== null;

  const order = await getOrder(http, auth.order.id);
  debugIds.get_order = order.debugId;
  rec.row("GET /v2/checkout/orders/{id}", order.data.id, order.data.status, order.debugId);
  const unit = order.data.purchase_units?.[0];
  const customId = unit?.custom_id ?? null;
  rec.check("S8", "GET order: custom_id round-trips exactly", customId === sample.customId, `got ${customId ?? "(missing)"}`, captured);
  rec.check("S8", "custom_id verifies against C_pre", customId !== null && customIdMatches(customId, sample.writShort, sample.cPre), "customIdMatches", captured);
  if (captured) {
    const orderInvoice = unit?.payments?.captures?.[0]?.invoice_id ?? null;
    rec.check("S8", "GET order: capture invoice_id visible on the order", orderInvoice === sample.invoiceId, `got ${orderInvoice ?? "(missing)"}`, false);
  }

  printTable(rec.rows);
  const s1 = rec.verdict("S1");
  const s8 = captured ? s8Verdict(rec) : "NOT RUN";
  const path = writeOut(outFile, {
    ...base,
    ...ids,
    flow: auth.flow,
    verdict: { S1: s1, S8: s8 },
    checks: rec.checks,
    rows: rec.rows,
    debug_ids: debugIds,
    paypal_exchanges: rec.exchanges,
  });
  console.log(`S1 ${kind}: ${s1}${kind === "capture" ? `   S8: ${s8}` : ""}`);
  console.log(`Saved ${path}`);

  const storedText = args.storedCredential ? `\`MERCHANT / SUBSEQUENT / ${AGENT_USAGE_PATTERN}\`` : "omitted (--no-stored-credential)";
  printMarkdown([
    kind === "capture"
      ? `### S1 + S8 — merchant-initiated AUTHORIZE -> capture, run \`${runId}\`, ${createdAt}`
      : `### S1 — merchant-initiated AUTHORIZE -> void, run \`${runId}\`, ${createdAt}`,
    "",
    `- **S1 ${kind}: ${s1}.** vault_id \`${vault.vault_id}\`, ${HERO_CURRENCY} 44.00, flow \`${auth.flow}\`, stored_credential ${storedText}.`,
    ...(kind === "capture"
      ? [`- **S8: ${s8}.** \`custom_id\` = \`${sample.customId}\`, \`invoice_id\` = \`${sample.invoiceId}\`.${s8 === "PASS" ? "" : ` Fallback: ${S8_FALLBACK}`}`]
      : []),
    `- Order \`${ids.order_id}\`, authorization \`${ids.authorization_id}\`${ids.capture_id === null ? "" : `, capture \`${ids.capture_id}\``}.`,
    `- usage_pattern decision: \`${AGENT_USAGE_PATTERN}\` (Vault v3: on-demand, non-recurring, variable amount and frequency).`,
    "",
    ...markdownRows(rec.rows),
    "",
    ...markdownChecks(rec.checks),
  ]);
  return s1 === "PASS" && (kind === "void" || s8 === "PASS") ? 0 : 1;
}

function s8Verdict(rec: Recorder): Verdict {
  const gating = rec.checks.filter((c) => c.spike === "S8" && c.gating);
  if (gating.every((c) => c.pass)) return "PASS";
  const customIdOk = gating.filter((c) => c.name.includes("custom_id")).every((c) => c.pass);
  return customIdOk ? "FALLBACK" : "FAIL";
}

function reportAuthorizeFallback(rec: Recorder, error: unknown, base: Record<string, unknown>, outFile: string, args: Args): number {
  const described = describeError(error);
  const flagsStoredCredential =
    error instanceof PayPalApiError &&
    error.details.some((d) => (d.field ?? "").includes("stored_credential") || (d.description ?? "").includes("stored_credential"));
  rec.row(
    "POST /v2/checkout/orders (AUTHORIZE, vault_id)",
    error instanceof PayPalFlowError ? error.resourceId : null,
    error instanceof PayPalFlowError ? error.status : "ERROR",
    described.debugId,
  );
  printTable(rec.rows);
  console.error(`\nMerchant-initiated AUTHORIZE failed: ${described.text}\nPayPal-Debug-Id: ${described.debugId ?? "none"}`);
  console.error(`\nS1 FALLBACK -> ${S1_FALLBACK.replaceAll("**", "")}`);
  console.error("Per §22 rules 6 and 43: post the Debug-Id and this error in the PayPal Discord and update plan.md; never work around it silently.");
  if (args.storedCredential && flagsStoredCredential) {
    console.error('PayPal flagged stored_credential. To isolate it, re-run once with "--no-stored-credential" and record both results.');
  }
  // A separate file, so a failed retry never overwrites the capture_id a passing run left for the disputes spike.
  const fallbackFile = outFile.replace(/\.json$/, ".fallback.json");
  const path = writeOut(fallbackFile, {
    ...base,
    order_id: error instanceof PayPalFlowError ? error.resourceId : null,
    authorization_id: null,
    capture_id: null,
    verdict: { S1: "FALLBACK", S8: "NOT RUN" },
    error: described.json,
    rows: rec.rows,
    paypal_exchanges: rec.exchanges,
  });
  console.log(`Saved ${path}`);
  const stored = args.storedCredential ? `MERCHANT/SUBSEQUENT/${AGENT_USAGE_PATTERN}` : "omitted";
  printMarkdown([
    `### S1 — merchant-initiated AUTHORIZE — FALLBACK, run \`${String(base.run_id)}\`, ${String(base.created_at)}`,
    "",
    `- POST /v2/checkout/orders (AUTHORIZE, vault_id \`${String(base.vault_id)}\`, stored_credential ${stored}) failed:`,
    `  \`${described.text}\` (PayPal-Debug-Id \`${described.debugId ?? "none"}\`).`,
    `- **Fallback chosen:** ${S1_FALLBACK}`,
    "- Reported in the PayPal Discord with the Debug-Id (§22 rule 6).",
    "",
    ...markdownRows(rec.rows),
  ]);
  return 1;
}

// ---------------------------------------------------------------------------------------------
// main

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, optionalEnv("SPIKE_PORT"));
  if (parsed === "help") {
    console.log(USAGE);
    return 0;
  }
  if (parsed.dryRun) {
    console.log("[dry run] no PayPal calls; request bodies only\n");
    return parsed.command === "setup" ? dryRunSetup(parsed) : dryRunOrderFlow(parsed.command, parsed);
  }
  if (parsed.command === "setup") return runSetup(parsed, openSession());
  // vault.json first: it is local and tells the user what to run before anything else.
  const vault = loadVaultFile();
  return runOrderFlow(parsed.command, parsed, vault, openSession());
}

main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof PayPalConfigError) {
      console.error(`${error.message}\n${describeEnv(PAYPAL_ENV_NAMES)}`);
      process.exitCode = 2;
      return;
    }
    const described = describeError(error);
    console.error(`spike-vault failed: ${described.text}${described.debugId === null ? "" : ` (PayPal-Debug-Id ${described.debugId})`}`);
    if (!(error instanceof PayPalError) && error instanceof Error && error.stack !== undefined) console.error(error.stack);
    process.exitCode = 1;
  },
);
