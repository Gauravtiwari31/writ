// Spike S2 (plan §17): the full sandbox dispute lifecycle on a Writ capture. Real sandbox calls only;
// prints every dispute id, status, available action and PayPal-Debug-Id, a PASS / FAIL verdict and a
// markdown block for docs/SPIKES.md, and saves scripts/.out/s2-dispute.json.
//
//   pnpm spike spike-disputes.ts create [--buyer-transaction-id <id>]   open a dispute as the sandbox buyer
//   pnpm spike spike-disputes.ts find                                    disputes on the S1 capture (UI-created ones too)
//   pnpm spike spike-disputes.ts status --dispute-id <id>                poll until PayPal offers actions
//   pnpm spike spike-disputes.ts defend --dispute-id <id>                [escalate] -> require-evidence -> provide-evidence -> adjudicate
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { minorToPayPalValue, payPalValueToMinor, type Currency } from "@writ/core";
import {
  adjudicate,
  buildCreateSandboxDisputeRequest,
  buildProvideEvidenceParts,
  consoleLogger,
  createDisputeClients,
  createSandboxDispute,
  DISPUTE_ACTION,
  DISPUTE_STAGE,
  DISPUTE_STATUS,
  escalateDispute,
  getDispute,
  listDisputes,
  PayPalApiError,
  PayPalConfigError,
  PayPalError,
  provideEvidence,
  requireEvidence,
  type DisputeClients,
  type DisputeView,
  type EvidenceInput,
  type PayPalLogEntry,
} from "@writ/paypal";
import { z } from "zod";
import { describeEnv, optionalEnv, requireEnv } from "./lib/env";
import { OUT_DIR, readOut, writeOut } from "./lib/out";

const OUT_FILE = "s2-dispute.json";
const S1_FILE = "s1-capture.json";
const DEFAULT_REASON = "MERCHANDISE_OR_SERVICE_NOT_RECEIVED";
const DEFAULT_WAIT_MINUTES = 20;
const RECENT_PATH = "/spikes/webhooks/recent";
const ENV_NAMES = ["PAYPAL_ENV", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_SANDBOX_BUYER_EMAIL", "GATEWAY_BASE_URL"] as const;

const UI_FALLBACK = `Fallback (plan §17 S2): create the dispute in the sandbox UI as the buyer, then automate the response side.
  1. Log in at https://www.sandbox.paypal.com as the sandbox PERSONAL buyer (PAYPAL_SANDBOX_BUYER_EMAIL).
  2. Activity > the $44.00 payment to the business account > "Report a problem" (Resolution Center), item not received.
  3. pnpm spike spike-disputes.ts find        (lists disputes on the S1 capture and recent ones)
  4. pnpm spike spike-disputes.ts defend --dispute-id <PP-D-...>`;

const USAGE = `Spike S2: full sandbox dispute lifecycle (plan §17)

Usage: pnpm spike spike-disputes.ts <command> [options]

Commands:
  create     POST /v1/customer/disputes as the sandbox buyer (PayPal-Auth-Assertion) for the S1 capture
             in scripts/.out/${S1_FILE}. PayPal documents --buyer-transaction-id (the id shown in the
             BUYER's sandbox activity); without it the script probes seller_transaction_id = capture id.
             Needs the app scope https://uri.paypal.com/services/disputes/create, which per PayPal's docs
             only a PayPal account manager can enable, plus buyer consent; expect a permission error otherwise.
  find       List disputes on the S1 capture (--transaction-id to override) and those opened in the last 7 days
  status     Poll the dispute with backoff until PayPal offers actions (they appear a few minutes after
             creation); --until <action> waits for a specific one, e.g. require-evidence
  defend     [escalate an INQUIRY to a claim] -> require-evidence (SELLER_EVIDENCE) -> provide-evidence
             (JSON notes + a small PDF) -> adjudicate SELLER_FAVOR -> RESOLVED; checks the gateway saw
             CUSTOMER.DISPUTE.RESOLVED verified

Options:
  --dispute-id <id>             status / defend
  --buyer-transaction-id <id>   create: the buyer-side transaction id
  --reason <REASON>             create: default ${DEFAULT_REASON}
  --amount <value>              create: disputed amount, e.g. 44.00 (default: the S1 capture amount)
  --transaction-id <id>         find: disputed transaction id (default: S1 capture id)
  --until <action>              status: action to wait for (default: any action)
  --evidence-type <TYPE>        defend: default OTHER (PROOF_OF_FULFILLMENT needs --tracking)
  --tracking <carrier:number>   defend: tracking_info for PROOF_OF_FULFILLMENT (label it simulated fulfillment)
  --wait-min <n>                polling budget per wait, minutes (default ${DEFAULT_WAIT_MINUTES}; 0 = read once)
  --dry-run                     create / defend: print requests and write the PDF; no PayPal calls
  -h, --help                    Show this help

Needs .env: PAYPAL_ENV=sandbox, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET; create also PAYPAL_SANDBOX_BUYER_EMAIL;
the RESOLVED-webhook check reads GATEWAY_BASE_URL${RECENT_PATH} (gateway with ENABLE_SPIKES=true).

${UI_FALLBACK}`;

class UsageError extends Error {}

const COMMANDS = ["create", "find", "status", "defend"] as const;
type Command = (typeof COMMANDS)[number];

interface Args {
  command: Command;
  disputeId: string | undefined;
  buyerTransactionId: string | undefined;
  transactionId: string | undefined;
  reason: string;
  amount: string | undefined;
  until: string | undefined;
  evidenceType: string | undefined;
  tracking: { carrier: string; number: string } | undefined;
  waitMinutes: number;
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
        "dispute-id": { type: "string" },
        "buyer-transaction-id": { type: "string" },
        "transaction-id": { type: "string" },
        reason: { type: "string" },
        amount: { type: "string" },
        until: { type: "string" },
        "evidence-type": { type: "string" },
        tracking: { type: "string" },
        "wait-min": { type: "string" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const v = parsed.values;
  if (v.help === true) return "help";
  const [command, ...rest] = parsed.positionals;
  if (command === undefined) throw new UsageError(`missing command: ${COMMANDS.join(", ")}`);
  if (!(COMMANDS as readonly string[]).includes(command)) throw new UsageError(`unknown command "${command}"`);
  if (rest.length > 0) throw new UsageError(`unexpected arguments: ${rest.join(" ")}`);
  const waitRaw = v["wait-min"];
  const waitMinutes = waitRaw === undefined ? DEFAULT_WAIT_MINUTES : Number(waitRaw);
  if (!Number.isInteger(waitMinutes) || waitMinutes < 0 || waitMinutes > 180) throw new UsageError("--wait-min must be 0-180");
  let tracking: Args["tracking"];
  if (v.tracking !== undefined) {
    const [carrier, number] = v.tracking.split(":");
    if (carrier === undefined || number === undefined || carrier === "" || number === "") throw new UsageError("--tracking must be <carrier>:<number>");
    tracking = { carrier, number };
  }
  return {
    command: command as Command,
    disputeId: v["dispute-id"],
    buyerTransactionId: v["buyer-transaction-id"],
    transactionId: v["transaction-id"],
    reason: v.reason ?? DEFAULT_REASON,
    amount: v.amount,
    until: v.until,
    evidenceType: v["evidence-type"],
    tracking,
    waitMinutes,
    dryRun: v["dry-run"] === true,
  };
}

// ---------------------------------------------------------------------------------------------
// Recording

interface Row {
  readonly step: string;
  readonly id: string | null;
  readonly status: string | null;
  readonly debugId: string | null;
  readonly detail: string;
}

interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

class Recorder {
  readonly exchanges: PayPalLogEntry[] = [];
  readonly rows: Row[] = [];
  readonly checks: Check[] = [];

  readonly logger = (entry: PayPalLogEntry): void => {
    this.exchanges.push(entry);
    consoleLogger(entry);
  };

  row(step: string, id: string | null, status: string | null, debugId: string | null, detail = ""): void {
    this.rows.push({ step, id, status, debugId, detail });
  }

  check(name: string, pass: boolean, detail: string): boolean {
    this.checks.push({ name, pass, detail });
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` (${detail})`}`);
    return pass;
  }
}

interface Session {
  readonly clients: DisputeClients;
  readonly rec: Recorder;
}

function openSession(): Session {
  const rec = new Recorder();
  const clients = createDisputeClients(process.env, { logger: rec.logger });
  console.log(`PayPal sandbox ${clients.http.config.baseUrl}  ${describeEnv(ENV_NAMES)}\n`);
  return { clients, rec };
}

function describeError(error: unknown): { text: string; debugId: string | null } {
  if (error instanceof PayPalApiError) {
    const issues = error.issues.length > 0 ? ` [${error.issues.join(", ")}]` : "";
    return { text: `${error.status} ${error.name}${issues}: ${error.paypalMessage}`, debugId: error.debugId };
  }
  const debugId = error instanceof PayPalError && "debugId" in error && typeof error.debugId === "string" ? error.debugId : null;
  return { text: error instanceof Error ? error.message : String(error), debugId };
}

function code(text: string | null | undefined): string {
  return text === null || text === undefined ? "-" : `\`${text}\``;
}

function printMarkdown(lines: readonly string[]): void {
  console.log("\n----- paste into docs/SPIKES.md -----8<-----");
  console.log(lines.join("\n"));
  console.log("----->8-----\n");
}

function markdownRows(rows: readonly Row[]): string[] {
  return [
    "| Step | Dispute / resource | Status | PayPal-Debug-Id | Detail |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.step} | ${code(r.id)} | ${r.status ?? "-"} | ${code(r.debugId)} | ${r.detail.replaceAll("|", "\\|")} |`),
  ];
}

/** Appends this run to scripts/.out/s2-dispute.json, keeping earlier steps for the same dispute. */
function saveRun(disputeId: string | null, run: Record<string, unknown>): string {
  const previous = readOut<{ dispute_id?: unknown; runs?: unknown }>(OUT_FILE);
  const runs = previous !== undefined && previous.dispute_id === disputeId && Array.isArray(previous.runs) ? previous.runs : [];
  return writeOut(OUT_FILE, { spike: "S2", dispute_id: disputeId, updated_at: new Date().toISOString(), runs: [...runs, run] });
}

// ---------------------------------------------------------------------------------------------
// S1 capture (the Writ purchase being disputed)

const S1Schema = z.looseObject({
  capture_id: z.string().min(1),
  order_id: z.string().optional(),
  amount_minor: z.string().regex(/^\d+$/),
  currency: z.literal("USD"),
  custom_id: z.string().optional(),
  invoice_id: z.string().nullable().optional(),
  c_pre_hex: z.string().optional(),
  c_post_hex: z.string().optional(),
});
type S1Capture = z.output<typeof S1Schema>;

function loadS1(required: boolean): S1Capture | null {
  const raw = readOut(S1_FILE);
  if (raw === undefined) {
    if (required) throw new UsageError(`scripts/.out/${S1_FILE} not found. Run "pnpm spike spike-vault.ts capture" first.`);
    return null;
  }
  const parsed = S1Schema.safeParse(raw);
  if (!parsed.success) {
    if (required) throw new UsageError(`scripts/.out/${S1_FILE} has no successful capture (capture_id/amount missing). Re-run spike-vault.ts capture.`);
    return null;
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Evidence: a JSON note and a tiny hand-built PDF (pdf-lib is not a dependency; this is ASCII-only)

function buildEvidencePdf(lines: readonly string[]): Uint8Array {
  const escape = (text: string): string => text.replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, (c) => `\\${c}`);
  const content = ["BT", "/F1 11 Tf", "14 TL", "72 740 Td", ...lines.map((line, i) => `${i === 0 ? "" : "T* "}(${escape(line)}) Tj`), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  // Every character is ASCII, so string offsets are byte offsets.
  return new TextEncoder().encode(pdf);
}

function evidenceFor(disputeId: string, s1: S1Capture | null, at: string): { note: string; pdf: Uint8Array } {
  const note = JSON.stringify({
    writ_evidence: {
      spike: "S2",
      environment: "PayPal sandbox (no real money)",
      dispute_id: disputeId,
      capture_id: s1?.capture_id ?? null,
      order_id: s1?.order_id ?? null,
      custom_id: s1?.custom_id ?? null,
      invoice_id: s1?.invoice_id ?? null,
      c_pre: s1?.c_pre_hex ?? null,
      c_post: s1?.c_post_hex ?? null,
      // Honest about what this run is (§22 rule 25): the S1 capture used sample commitments, not a signed Writ.
      statement:
        "Spike S2 sandbox test. The disputed capture comes from spike S1, whose custom_id / invoice_id carry SAMPLE Writ commitments; " +
        "the passkey-signed Writ and full evidence pack arrive with P0-1 and P0-7.",
      generated_at: at,
    },
  });
  const pdf = buildEvidencePdf([
    "Writ dispute evidence - PayPal SANDBOX test document (spike S2, no real money)",
    `Dispute ${disputeId}`,
    `Capture ${s1?.capture_id ?? "-"}   Order ${s1?.order_id ?? "-"}`,
    `custom_id (pre-commitment)  ${s1?.custom_id ?? "-"}`,
    `invoice_id (post-commitment) ${s1?.invoice_id ?? "-"}`,
    "Spike test: the commitments above are SAMPLE values from spike S1, not a signed Writ.",
    "The passkey-signed Writ and the full evidence pack (JSON + PDF) arrive with P0-1 and P0-7.",
    `Generated ${at}`,
  ]);
  return { note, pdf };
}

function evidenceInput(args: Args, note: string): EvidenceInput {
  const type = args.evidenceType ?? (args.tracking === undefined ? "OTHER" : "PROOF_OF_FULFILLMENT");
  return {
    evidenceType: type,
    notes: note,
    ...(args.tracking === undefined
      ? {}
      : { evidenceInfo: { tracking_info: [{ carrier_name: args.tracking.carrier, tracking_number: args.tracking.number }] } }),
  };
}

// ---------------------------------------------------------------------------------------------
// Polling

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Re-reads the dispute with backoff (5 s, x1.5, capped at 60 s) until `done` or the budget runs out. */
async function pollDispute(
  { clients, rec }: Session,
  disputeId: string,
  label: string,
  done: (view: DisputeView) => boolean,
  waitMinutes: number,
): Promise<DisputeView> {
  const deadline = Date.now() + waitMinutes * 60_000;
  let delay = 5_000;
  for (;;) {
    const view = await getDispute(clients.http, disputeId);
    const d = view.dispute;
    const actions = view.actions.join(", ") || "(none yet)";
    console.log(`  [${new Date().toISOString()}] ${d.status} / ${d.dispute_life_cycle_stage ?? "-"}  actions: ${actions}  debug_id=${view.debugId ?? "none"}`);
    if (done(view) || Date.now() >= deadline) {
      rec.row(`GET dispute (${label})`, d.dispute_id, d.status, view.debugId, `stage ${d.dispute_life_cycle_stage ?? "-"}; actions ${actions}`);
      return view;
    }
    await sleep(Math.min(delay, Math.max(1_000, deadline - Date.now())));
    delay = Math.min(Math.round(delay * 1.5), 60_000);
  }
}

// ---------------------------------------------------------------------------------------------
// Commands

async function runCreate(args: Args): Promise<number> {
  // A dry run only prints the request, so it works before spike-vault.ts capture has produced a capture.
  const s1 = loadS1(!args.dryRun) ?? { capture_id: "DRY_RUN_CAPTURE_ID", amount_minor: "4400", currency: "USD" as const };
  const currency: Currency = s1.currency;
  const amountMinor = args.amount === undefined ? BigInt(s1.amount_minor) : payPalValueToMinor(args.amount, currency);
  if (amountMinor > BigInt(s1.amount_minor)) throw new UsageError("the disputed amount must not exceed the captured amount");
  const transaction =
    args.buyerTransactionId === undefined ? { sellerTransactionId: s1.capture_id } : { buyerTransactionId: args.buyerTransactionId };
  const body = buildCreateSandboxDisputeRequest({ transaction, reason: args.reason, amountMinor, currency });
  if (args.buyerTransactionId === undefined) {
    console.warn("No --buyer-transaction-id: probing seller_transaction_id = S1 capture id. PayPal documents buyer_transaction_id only.\n");
  }
  if (args.dryRun) {
    console.log("POST /v1/customer/disputes  (multipart: input;type=application/json)  PayPal-Auth-Assertion: <alg none JWT: iss=client id, email=buyer>");
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }
  const buyerEmail = requireEnv("PAYPAL_SANDBOX_BUYER_EMAIL");
  const session = openSession();
  const { rec } = session;
  const at = new Date().toISOString();
  const requestId = `s2-create:${s1.capture_id}:${args.buyerTransactionId ?? "seller"}`;
  try {
    const created = await createSandboxDispute(session.clients.multipart, { buyerEmail, transaction, reason: args.reason, amountMinor, currency, requestId });
    rec.row("POST /v1/customer/disputes (sandbox, as buyer)", created.disputeId, `HTTP ${created.status}`, created.debugId, args.reason);
    rec.check("dispute created", created.disputeId !== null, `dispute ${created.disputeId ?? "(no id in links)"}`);
    const path = saveRun(created.disputeId, { step: "create", at, capture_id: s1.capture_id, request: body, rows: rec.rows, checks: rec.checks, paypal_exchanges: rec.exchanges });
    console.log(`\nSaved ${path}`);
    console.log(`Actions appear a few minutes after creation. Next:\n  pnpm spike spike-disputes.ts status --dispute-id ${created.disputeId ?? "<id>"}`);
    printMarkdown([
      `### S2a — dispute created by API, ${at}`,
      "",
      `- Dispute ${code(created.disputeId)} on capture ${code(s1.capture_id)}, reason \`${args.reason}\`, ${currency} ${minorToPayPalValue(amountMinor, currency)}.`,
      `- Transaction reference: ${args.buyerTransactionId === undefined ? "`seller_transaction_id` (undocumented probe)" : "`buyer_transaction_id`"}.`,
      "",
      ...markdownRows(rec.rows),
    ]);
    return created.disputeId === null ? 1 : 0;
  } catch (error) {
    const described = describeError(error);
    rec.row("POST /v1/customer/disputes (sandbox, as buyer)", null, "ERROR", described.debugId, described.text);
    console.error(`\nCreate dispute failed: ${described.text}\nPayPal-Debug-Id: ${described.debugId ?? "none"}`);
    if (error instanceof PayPalApiError && error.details.length > 0) console.error(JSON.stringify(error.details, null, 2));
    console.error(`\n${UI_FALLBACK}`);
    const path = saveRun(null, { step: "create", at, capture_id: s1.capture_id, request: body, error: described, rows: rec.rows, paypal_exchanges: rec.exchanges });
    console.log(`\nSaved ${path}`);
    printMarkdown([
      `### S2a — dispute creation by API — FAILED, ${at}`,
      "",
      `- \`POST /v1/customer/disputes\` -> \`${described.text}\` (PayPal-Debug-Id ${code(described.debugId)}).`,
      "- PayPal docs: creating disputes by API needs the app scope `https://uri.paypal.com/services/disputes/create` (enabled by a PayPal account manager) and buyer consent via Log in with PayPal.",
      "- **Fallback chosen:** dispute created in the sandbox Resolution Center UI as the buyer; the response side is automated (plan §17 S2).",
      "",
      ...markdownRows(rec.rows),
    ]);
    return 1;
  }
}

async function runFind(args: Args): Promise<number> {
  const s1 = loadS1(false);
  const transactionId = args.transactionId ?? s1?.capture_id;
  const { clients } = openSession();
  if (transactionId !== undefined) {
    const byTxn = await listDisputes(clients.http, { disputedTransactionId: transactionId });
    const items = byTxn.data.items ?? [];
    console.log(`Disputes on transaction ${transactionId}: ${items.length}  (debug_id=${byTxn.debugId ?? "none"})`);
    for (const d of items) console.log(`  ${d.dispute_id}  ${d.status}  ${d.reason ?? "-"}  ${d.dispute_amount?.value ?? "-"} ${d.dispute_amount?.currency_code ?? ""}  ${d.create_time ?? "-"}`);
  }
  const since = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
  const recent = await listDisputes(clients.http, { startTime: since, pageSize: 20 });
  const items = recent.data.items ?? [];
  console.log(`\nDisputes opened since ${since}: ${items.length}  (debug_id=${recent.debugId ?? "none"})`);
  for (const d of items) console.log(`  ${d.dispute_id}  ${d.status}  ${d.reason ?? "-"}  ${d.dispute_amount?.value ?? "-"} ${d.dispute_amount?.currency_code ?? ""}  ${d.create_time ?? "-"}`);
  return 0;
}

function disputeIdOrThrow(args: Args): string {
  if (args.disputeId === undefined) throw new UsageError('this command needs --dispute-id <id> (see "find")');
  return args.disputeId;
}

async function runStatus(args: Args): Promise<number> {
  const disputeId = disputeIdOrThrow(args);
  const session = openSession();
  const wanted = args.until;
  const view = await pollDispute(
    session,
    disputeId,
    wanted === undefined ? "any action" : `until ${wanted}`,
    (v) => (wanted === undefined ? v.actions.length > 0 : v.actions.includes(wanted)) || v.dispute.status === DISPUTE_STATUS.RESOLVED,
    args.waitMinutes,
  );
  const d = view.dispute;
  console.log(`\n${d.dispute_id}: ${d.status}, stage ${d.dispute_life_cycle_stage ?? "-"}, reason ${d.reason ?? "-"}`);
  console.log(`transactions: ${JSON.stringify(d.disputed_transactions ?? [])}`);
  console.log(`actions: ${view.actions.join(", ") || "(none yet: retry in a few minutes)"}`);
  const requested = (d.evidences ?? []).filter((e) => e.source === "REQUESTED_FROM_SELLER").map((e) => e.evidence_type ?? "?");
  if (requested.length > 0) console.log(`evidence requested from seller: ${requested.join(", ")}`);
  const path = saveRun(disputeId, { step: "status", at: new Date().toISOString(), status: d.status, actions: view.actions, rows: session.rec.rows, paypal_exchanges: session.rec.exchanges });
  console.log(`Saved ${path}`);
  return 0;
}

const RecentSchema = z.looseObject({
  deliveries: z.array(
    z.looseObject({
      outcome: z.string(),
      event_id: z.string().nullable(),
      event_type: z.string().nullable(),
      resource_id: z.string().nullable(),
      verification_status: z.string().nullable(),
      paypal_debug_id: z.string().nullable(),
      received_at: z.string(),
    }),
  ),
});

/** Looks for CUSTOMER.DISPUTE.RESOLVED for this dispute, verified by the gateway (spike S3 status route). */
async function waitForResolvedWebhook(disputeId: string, minutes: number): Promise<{ checked: boolean; found: z.output<typeof RecentSchema>["deliveries"][number] | null; note: string }> {
  const base = optionalEnv("GATEWAY_BASE_URL");
  if (base === undefined) return { checked: false, found: null, note: "GATEWAY_BASE_URL not set; check the Render log for CUSTOMER.DISPUTE.RESOLVED" };
  const deadline = Date.now() + minutes * 60_000;
  let note: string;
  for (;;) {
    try {
      const response = await fetch(`${new URL(base).origin}${RECENT_PATH}`, { signal: AbortSignal.timeout(15_000) });
      if (response.ok) {
        const parsed = RecentSchema.safeParse(await response.json());
        const found = parsed.success
          ? (parsed.data.deliveries.find((d) => d.event_type === "CUSTOMER.DISPUTE.RESOLVED" && d.resource_id === disputeId && d.outcome === "verified") ?? null)
          : null;
        if (found !== null) return { checked: true, found, note: "verified by the gateway" };
        note = parsed.success ? "not received yet" : "unexpected response shape";
      } else {
        note = `GET ${RECENT_PATH} -> ${response.status} (ENABLE_SPIKES=true on the gateway?)`;
        if (response.status === 404) return { checked: false, found: null, note };
      }
    } catch (error) {
      note = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) return { checked: true, found: null, note };
    await sleep(15_000);
  }
}

async function runDefend(args: Args): Promise<number> {
  const disputeId = disputeIdOrThrow(args);
  const s1 = loadS1(false);
  const at = new Date().toISOString();
  const { note, pdf } = evidenceFor(disputeId, s1, at);
  const evidence = evidenceInput(args, note);
  const files = [{ filename: "writ-evidence.pdf", contentType: "application/pdf" as const, data: pdf }];
  const parts = buildProvideEvidenceParts({ evidences: [evidence], files });
  // Both are kept next to the run record so the submitted evidence can be inspected later.
  const inputPath = writeOut("s2-evidence-input.json", { evidences: [evidence] });
  const pdfPath = resolve(OUT_DIR, "s2-evidence.pdf");
  writeFileSync(pdfPath, pdf);
  if (args.dryRun) {
    console.log(`POST /v1/customer/disputes/${disputeId}/provide-evidence (multipart)`);
    for (const p of parts) console.log(`  part ${p.name}${p.filename === undefined ? "" : ` filename=${p.filename}`} ${p.contentType} ${typeof p.data === "string" ? `${p.data.length} chars` : `${p.data.byteLength} bytes`}`);
    console.log(`\ninput part: ${inputPath}\nPDF: ${pdfPath} (open it to check it renders)`);
    return 0;
  }

  const session = openSession();
  const { clients, rec } = session;
  const wait = args.waitMinutes;
  const isResolved = (v: DisputeView): boolean => v.dispute.status === DISPUTE_STATUS.RESOLVED;
  let view = await pollDispute(session, disputeId, "start", () => true, 0);

  // 0. A dispute the buyer opens in the UI usually starts as an INQUIRY, which PayPal never adjudicates.
  //    The merchant escalates it to a claim (UNDER_REVIEW) so require-evidence and adjudicate appear.
  const isInquiry = (v: DisputeView): boolean => v.dispute.dispute_life_cycle_stage === DISPUTE_STAGE.INQUIRY;
  if (!isResolved(view) && isInquiry(view) && !view.actions.includes(DISPUTE_ACTION.REQUIRE_EVIDENCE)) {
    view = await pollDispute(
      session,
      disputeId,
      "until escalate",
      (v) => v.actions.includes(DISPUTE_ACTION.ESCALATE) || v.actions.includes(DISPUTE_ACTION.REQUIRE_EVIDENCE) || !isInquiry(v) || isResolved(v),
      wait,
    );
    if (isInquiry(view) && view.actions.includes(DISPUTE_ACTION.ESCALATE) && !view.actions.includes(DISPUTE_ACTION.REQUIRE_EVIDENCE)) {
      try {
        const r = await escalateDispute(clients.http, {
          disputeId,
          note: "Sandbox spike S2: escalating the inquiry to a claim so the evidence and adjudication steps can be exercised.",
        });
        rec.row("POST escalate (INQUIRY -> claim)", disputeId, `HTTP ${r.status}`, r.debugId);
        rec.check("escalated to a claim", r.status === 200, `HTTP ${r.status}`);
      } catch (error) {
        const described = describeError(error);
        rec.row("POST escalate (INQUIRY -> claim)", disputeId, "ERROR", described.debugId, described.text);
        rec.check("escalated to a claim", false, described.text);
      }
      view = await pollDispute(session, disputeId, "after escalate", (v) => !isInquiry(v) || isResolved(v), Math.min(wait, 10));
    }
  }

  // 1. Seller evidence window: require-evidence (sandbox) when PayPal offers it.
  if (!isResolved(view) && view.dispute.status !== DISPUTE_STATUS.WAITING_FOR_SELLER_RESPONSE) {
    view = await pollDispute(
      session,
      disputeId,
      "until require-evidence or provide-evidence",
      (v) => v.actions.includes(DISPUTE_ACTION.REQUIRE_EVIDENCE) || v.actions.includes(DISPUTE_ACTION.PROVIDE_EVIDENCE) || isResolved(v),
      wait,
    );
    if (view.actions.includes(DISPUTE_ACTION.PROVIDE_EVIDENCE)) {
      rec.check("require-evidence accepted", true, "skipped: PayPal already offers provide-evidence");
    } else if (view.actions.includes(DISPUTE_ACTION.REQUIRE_EVIDENCE)) {
      try {
        const r = await requireEvidence(clients.http, { disputeId, action: "SELLER_EVIDENCE" });
        rec.row("POST require-evidence (SELLER_EVIDENCE, sandbox)", disputeId, `HTTP ${r.status}`, r.debugId);
        rec.check("require-evidence accepted", r.status === 200, `HTTP ${r.status}`);
      } catch (error) {
        const described = describeError(error);
        rec.row("POST require-evidence (SELLER_EVIDENCE, sandbox)", disputeId, "ERROR", described.debugId, described.text);
        rec.check("require-evidence accepted", false, described.text);
      }
    } else if (!isResolved(view)) {
      rec.check("require-evidence accepted", false, `action not offered after ${wait} min (status ${view.dispute.status})`);
    }
  } else {
    rec.check("require-evidence accepted", true, `skipped: dispute already ${view.dispute.status}`);
  }

  // 2. provide-evidence once PayPal offers it.
  if (!isResolved(view)) {
    view = await pollDispute(session, disputeId, "until provide-evidence", (v) => v.actions.includes(DISPUTE_ACTION.PROVIDE_EVIDENCE) || isResolved(v), wait);
  }
  const requested = (view.dispute.evidences ?? []).filter((e) => e.source === "REQUESTED_FROM_SELLER").map((e) => e.evidence_type ?? "?");
  if (requested.length > 0) console.log(`  evidence requested from seller: ${requested.join(", ")}; sending ${evidence.evidenceType}`);
  if (view.actions.includes(DISPUTE_ACTION.PROVIDE_EVIDENCE)) {
    try {
      const r = await provideEvidence(clients.multipart, { disputeId, evidences: [evidence], files, requestId: `${disputeId}:provide-evidence:${at}` });
      rec.row("POST provide-evidence (input JSON + file1 PDF)", disputeId, `HTTP ${r.status}`, r.debugId, `${evidence.evidenceType}, ${pdf.byteLength}-byte PDF`);
      rec.check("provide-evidence accepted", r.status === 200, `HTTP ${r.status}`);
    } catch (error) {
      const described = describeError(error);
      rec.row("POST provide-evidence (input JSON + file1 PDF)", disputeId, "ERROR", described.debugId, described.text);
      rec.check("provide-evidence accepted", false, described.text);
    }
  } else {
    rec.check("provide-evidence accepted", false, `action not offered (status ${view.dispute.status}, actions ${view.actions.join(", ") || "none"})`);
  }

  // 3. adjudicate SELLER_FAVOR (sandbox) once the dispute is UNDER_REVIEW.
  if (!isResolved(view)) {
    view = await pollDispute(session, disputeId, "until adjudicate", (v) => v.actions.includes(DISPUTE_ACTION.ADJUDICATE) || isResolved(v), wait);
  }
  if (view.actions.includes(DISPUTE_ACTION.ADJUDICATE)) {
    try {
      const r = await adjudicate(clients.http, { disputeId, outcome: "SELLER_FAVOR" });
      rec.row("POST adjudicate (SELLER_FAVOR, sandbox)", disputeId, `HTTP ${r.status}`, r.debugId);
      rec.check("adjudicate accepted", r.status === 200, `HTTP ${r.status}`);
    } catch (error) {
      const described = describeError(error);
      rec.row("POST adjudicate (SELLER_FAVOR, sandbox)", disputeId, "ERROR", described.debugId, described.text);
      rec.check("adjudicate accepted", false, described.text);
    }
  } else if (!isResolved(view)) {
    rec.check("adjudicate accepted", false, `action not offered (status ${view.dispute.status})`);
  }

  // 4. Final state and the RESOLVED webhook.
  view = await pollDispute(session, disputeId, "final", isResolved, isResolved(view) ? 0 : Math.min(wait, 10));
  const outcome = view.dispute.dispute_outcome?.outcome_code ?? null;
  rec.check("dispute RESOLVED", isResolved(view), `status ${view.dispute.status}`);
  rec.check("resolved in the seller's favour", outcome !== null && outcome.includes("SELLER"), `outcome_code ${outcome ?? "(none)"}`);
  const webhook = await waitForResolvedWebhook(disputeId, isResolved(view) ? 5 : 0);
  if (webhook.checked) {
    rec.check("CUSTOMER.DISPUTE.RESOLVED webhook verified by the gateway", webhook.found !== null, webhook.found === null ? webhook.note : `event ${webhook.found.event_id ?? "-"}, debug_id ${webhook.found.paypal_debug_id ?? "-"}`);
  } else {
    console.log(`  info  RESOLVED webhook not checked: ${webhook.note}`);
  }

  const allPass = rec.checks.every((c) => c.pass);
  const verdict = allPass ? (webhook.checked ? "PASS" : "PASS (webhook unchecked)") : "FAIL";
  console.log(`\nS2: ${verdict}`);
  const path = saveRun(disputeId, {
    step: "defend",
    at,
    verdict,
    capture_id: s1?.capture_id ?? null,
    evidence_type: evidence.evidenceType,
    pdf_bytes: pdf.byteLength,
    outcome_code: outcome,
    resolved_webhook: webhook,
    rows: rec.rows,
    checks: rec.checks,
    paypal_exchanges: rec.exchanges,
  });
  console.log(`Saved ${path}`);
  printMarkdown([
    `### S2 — dispute lifecycle on a Writ capture, ${at}`,
    "",
    `- **S2: ${verdict}.** Dispute ${code(disputeId)} on capture ${code(s1?.capture_id)}; final status \`${view.dispute.status}\`, outcome \`${outcome ?? "-"}\`.`,
    `- Evidence: \`${evidence.evidenceType}\` with a JSON note (Writ commitments) + \`writ-evidence.pdf\` (${pdf.byteLength} bytes) as multipart \`input\` + \`file1\`.`,
    `- RESOLVED webhook: ${webhook.found === null ? webhook.note : `event ${code(webhook.found.event_id)} verified, PayPal-Debug-Id ${code(webhook.found.paypal_debug_id)}`}.`,
    ...(allPass ? [] : ["- Fallback if red: create disputes in the sandbox UI before recording; automate only the response side (plan §17 S2)."]),
    "",
    ...markdownRows(rec.rows),
    "",
    "| Check | Result | Detail |",
    "|---|---|---|",
    ...rec.checks.map((c) => `| ${c.name} | ${c.pass ? "PASS" : "FAIL"} | ${c.detail.replaceAll("|", "\\|")} |`),
  ]);
  return allPass ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const args = parseCli(argv);
  if (args === "help") {
    console.log(USAGE);
    return 0;
  }
  switch (args.command) {
    case "create":
      return runCreate(args);
    case "find":
      return runFind(args);
    case "status":
      return runStatus(args);
    case "defend":
      return runDefend(args);
  }
}

main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    if (error instanceof UsageError || error instanceof PayPalConfigError) {
      console.error(`${error.message}\n\nRun with --help for usage.`);
      process.exitCode = 2;
      return;
    }
    const described = describeError(error);
    // §22 rule 43: report the exact response with its PayPal-Debug-Id.
    console.error(`${described.text}${described.debugId === null ? "" : ` (PayPal-Debug-Id ${described.debugId})`}`);
    if (error instanceof PayPalApiError && error.details.length > 0) console.error(JSON.stringify(error.details, null, 2));
    process.exitCode = 1;
  },
);
