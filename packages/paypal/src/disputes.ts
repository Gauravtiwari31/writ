// Disputes v1: read a dispute, answer it (provide-evidence, accept-claim), and the sandbox-only
// simulation calls (create, require-evidence, adjudicate) used by spike S2 and judge mode. Answers
// carry evidence only; no call here takes a payee or moves money except accept-claim (a refund PayPal
// executes from the merchant balance), which the dispute engine calls only on a typed decision.
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { minorToPayPalValue, toBase64Url, utf8, type Currency } from "@writ/core";
import { z } from "zod";
import { PayPalTokenProvider } from "./auth";
import { assertSandbox, loadPayPalConfig, PayPalConfigError, type EnvSource, type PayPalConfig } from "./config";
import { PayPalResponseError, toApiError } from "./errors";
import { MAX_REQUEST_ID_LENGTH, PayPalHttp, seg, type AccessTokenSource, type PayPalHttpOptions, type PayPalResponse } from "./http";
import { LinkSchema, MoneySchema, type Link } from "./schemas";
import { consoleLogger, DEFAULT_TIMEOUT_MS, send, type FetchLike, type PayPalLogger, type RawResponse } from "./transport";

export const DISPUTES_PATH = "/v1/customer/disputes";

/** Disputes v1 `status` values. */
export const DISPUTE_STATUS = {
  OPEN: "OPEN",
  WAITING_FOR_BUYER_RESPONSE: "WAITING_FOR_BUYER_RESPONSE",
  WAITING_FOR_SELLER_RESPONSE: "WAITING_FOR_SELLER_RESPONSE",
  UNDER_REVIEW: "UNDER_REVIEW",
  RESOLVED: "RESOLVED",
  OTHER: "OTHER",
} as const;

/** Disputes v1 `dispute_life_cycle_stage` values. */
export const DISPUTE_STAGE = {
  INQUIRY: "INQUIRY",
  CHARGEBACK: "CHARGEBACK",
  PRE_ARBITRATION: "PRE_ARBITRATION",
  ARBITRATION: "ARBITRATION",
} as const;

/** Action names as they appear in the HATEOAS link paths (/v1/customer/disputes/{id}/<action>). */
export const DISPUTE_ACTION = {
  PROVIDE_EVIDENCE: "provide-evidence",
  ACCEPT_CLAIM: "accept-claim",
  REQUIRE_EVIDENCE: "require-evidence",
  ADJUDICATE: "adjudicate",
  SEND_MESSAGE: "send-message",
  MAKE_OFFER: "make-offer",
  ESCALATE: "escalate",
  APPEAL: "appeal",
} as const;

// ---------------------------------------------------------------------------------------------
// Response schemas (lenient: statuses and reasons stay strings, PayPal adds values over time)

const DisputedTransactionSchema = z.looseObject({
  seller_transaction_id: z.string().optional(),
  buyer_transaction_id: z.string().optional(),
  custom: z.string().optional(),
});

const EvidenceSchema = z.looseObject({
  evidence_type: z.string().optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
  date: z.string().optional(),
  documents: z.array(z.looseObject({ name: z.string().optional() })).optional(),
});

export const DisputeSchema = z.looseObject({
  dispute_id: z.string().min(1),
  status: z.string(),
  reason: z.string().optional(),
  dispute_state: z.string().optional(),
  dispute_life_cycle_stage: z.string().optional(),
  dispute_channel: z.string().optional(),
  dispute_amount: MoneySchema.optional(),
  disputed_transactions: z.array(DisputedTransactionSchema).optional(),
  dispute_outcome: z.looseObject({ outcome_code: z.string().optional() }).optional(),
  evidences: z.array(EvidenceSchema).optional(),
  seller_response_due_date: z.string().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(LinkSchema).optional(),
});
export type Dispute = z.output<typeof DisputeSchema>;

export const DisputeListSchema = z.looseObject({
  items: z.array(DisputeSchema).optional(),
  links: z.array(LinkSchema).optional(),
});
export type DisputeList = z.output<typeof DisputeListSchema>;

/** Every dispute action answers 200 with a link back to the dispute. */
export const SubsequentActionSchema = z.looseObject({ links: z.array(LinkSchema).optional() });
export type SubsequentAction = z.output<typeof SubsequentActionSchema>;

const NON_ACTION_RELS = new Set(["self", "first", "last", "next", "previous", "prev"]);

/**
 * The actions PayPal currently allows on a dispute, from its HATEOAS links (POST links other than
 * navigation). Named by the last path segment, falling back to the rel with "_" read as "-".
 * Sandbox actions appear a few minutes after a dispute is created, so poll for them.
 */
export function disputeActions(links: readonly Link[] | undefined): string[] {
  const actions = new Set<string>();
  for (const link of links ?? []) {
    if (NON_ACTION_RELS.has(link.rel) || (link.method !== undefined && link.method.toUpperCase() !== "POST")) continue;
    let fromPath: string | undefined;
    try {
      const parts = new URL(link.href).pathname.split("/").filter((p) => p !== "");
      // ["v1", "customer", "disputes", "<id>", "<action>"]
      if (parts.length === 5 && parts[2] === "disputes") fromPath = parts[4];
    } catch {
      fromPath = undefined;
    }
    actions.add(fromPath ?? link.rel.toLowerCase().replaceAll("_", "-"));
  }
  return [...actions];
}

export function hasDisputeAction(dispute: Pick<Dispute, "links">, action: string): boolean {
  return disputeActions(dispute.links).includes(action);
}

/** Reads the dispute id from a create/action response (`self` link ends in /disputes/{id}). */
export function disputeIdFromLinks(links: readonly Link[] | undefined): string | null {
  const self = links?.find((link) => link.rel === "self") ?? links?.[0];
  if (self === undefined) return null;
  try {
    const parts = new URL(self.href).pathname.split("/").filter((p) => p !== "");
    return parts[2] === "disputes" && parts[3] !== undefined ? decodeURIComponent(parts[3]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Multipart transport. PayPalHttp sends JSON only; provide-evidence and the sandbox create call are
// multipart/form-data, so this client shares PayPalHttp's token source, transport and error mapping.

export interface MultipartPart {
  readonly name: string;
  /** Present for file parts only; the JSON `input` part has none, exactly like curl -F 'input=...;type=application/json'. */
  readonly filename?: string;
  readonly contentType: string;
  readonly data: Uint8Array | string;
}

export interface EncodedMultipart {
  readonly boundary: string;
  /** Value for the Content-Type request header. */
  readonly contentType: string;
  readonly body: Uint8Array;
}

const HEADER_SAFE_RE = /^[^"\r\n\\]+$/;

function newBoundary(): string {
  return `----writ-${randomBytes(12).toString("hex")}`;
}

/**
 * Encodes parts as multipart/form-data by hand. FormData cannot express a typed part without a
 * filename (a Blob part always gets filename="blob"), and PayPal documents `input` as a JSON part
 * with no filename, so the wire format is built explicitly and binary file bytes pass unchanged.
 */
export function encodeMultipart(parts: readonly MultipartPart[], boundary: string = newBoundary()): EncodedMultipart {
  if (parts.length === 0) throw new TypeError("multipart body needs at least one part");
  if (!/^[A-Za-z0-9'()+_,./:=?-]{1,70}$/.test(boundary)) throw new TypeError("invalid multipart boundary");
  const delimiter = Buffer.from(`--${boundary}`, "latin1");
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (!HEADER_SAFE_RE.test(part.name)) throw new TypeError(`invalid part name ${JSON.stringify(part.name)}`);
    if (part.filename !== undefined && !HEADER_SAFE_RE.test(part.filename)) throw new TypeError(`invalid filename ${JSON.stringify(part.filename)}`);
    if (!HEADER_SAFE_RE.test(part.contentType)) throw new TypeError(`invalid content type ${JSON.stringify(part.contentType)}`);
    const data = typeof part.data === "string" ? Buffer.from(part.data, "utf8") : Buffer.from(part.data.buffer, part.data.byteOffset, part.data.byteLength);
    if (data.includes(delimiter)) throw new TypeError("part data contains the multipart boundary");
    const disposition = `form-data; name="${part.name}"${part.filename === undefined ? "" : `; filename="${part.filename}"`}`;
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: ${part.contentType}\r\n\r\n`, "utf8"),
      data,
      Buffer.from("\r\n", "latin1"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "latin1"));
  const joined = Buffer.concat(chunks);
  return {
    boundary,
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength),
  };
}

export interface PayPalMultipartOptions {
  readonly config: PayPalConfig;
  /** Share the PayPalHttp's token source so both clients use one cached OAuth token. */
  readonly tokens: AccessTokenSource;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly logger?: PayPalLogger;
}

export interface MultipartPostOptions {
  readonly requestId: string;
  /** Extra headers (e.g. PayPal-Auth-Assertion). Authorization, Content-Type and PayPal-Request-Id always win. */
  readonly headers?: Readonly<Record<string, string>>;
}

export class PayPalMultipartClient {
  readonly config: PayPalConfig;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #logger: PayPalLogger;
  readonly #tokens: AccessTokenSource;

  constructor(options: PayPalMultipartOptions) {
    assertSandbox(options.config);
    this.config = options.config;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#logger = options.logger ?? consoleLogger;
    this.#tokens = options.tokens;
  }

  async post<S extends z.ZodType>(
    path: string,
    parts: readonly MultipartPart[],
    schema: S,
    options: MultipartPostOptions,
  ): Promise<PayPalResponse<z.output<S>>> {
    if (options.requestId.trim() === "" || options.requestId.length > MAX_REQUEST_ID_LENGTH) {
      throw new TypeError(`PayPal-Request-Id must be 1-${MAX_REQUEST_ID_LENGTH} chars`);
    }
    const encoded = encodeMultipart(parts);
    let token = await this.#tokens.getAccessToken();
    let raw = await this.#send(path, encoded, token, options);
    if (raw.status === 401) {
      // Same rule as PayPalHttp: one retry with a fresh token and the same PayPal-Request-Id.
      this.#tokens.invalidate(token);
      token = await this.#tokens.getAccessToken();
      raw = await this.#send(path, encoded, token, options);
    }
    if (raw.status < 200 || raw.status >= 300) {
      throw toApiError({ method: "POST", path, status: raw.status, headerDebugId: raw.debugId, body: raw.json, rawText: raw.rawText });
    }
    if (raw.json === undefined) throw new PayPalResponseError("POST", path, raw.status, raw.debugId, ["body is not valid JSON"]);
    const parsed = schema.safeParse(raw.json);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.code}`);
      throw new PayPalResponseError("POST", path, raw.status, raw.debugId, problems);
    }
    return { status: raw.status, data: parsed.data, debugId: raw.debugId };
  }

  #send(path: string, encoded: EncodedMultipart, token: string, options: MultipartPostOptions): Promise<RawResponse> {
    const headers: Record<string, string> = {
      ...options.headers,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": encoded.contentType,
      "PayPal-Request-Id": options.requestId,
    };
    const baseFetch = this.#fetch;
    // The shared transport sends string bodies only; the wrapper attaches the binary body.
    const withBody: FetchLike = (url, init) => baseFetch(url, { ...init, body: encoded.body });
    return send({
      fetch: withBody,
      baseUrl: this.config.baseUrl,
      method: "POST",
      path,
      headers,
      timeoutMs: this.#timeoutMs,
      logger: this.#logger,
      requestId: options.requestId,
      now: this.#now,
    });
  }
}

export interface DisputeClients {
  readonly http: PayPalHttp;
  readonly multipart: PayPalMultipartClient;
}

/** Loads the sandbox-only config from the environment and builds both clients on one token cache. */
export function createDisputeClients(env: EnvSource = process.env, options: Omit<PayPalHttpOptions, "config" | "tokens"> = {}): DisputeClients {
  const config = loadPayPalConfig(env);
  const tokens = new PayPalTokenProvider({ ...options, config });
  return { http: new PayPalHttp({ ...options, config, tokens }), multipart: new PayPalMultipartClient({ ...options, config, tokens }) };
}

// ---------------------------------------------------------------------------------------------
// Read

export interface ListDisputesInput {
  /** The seller transaction id (our capture id) or buyer transaction id. */
  readonly disputedTransactionId?: string;
  readonly startTime?: string;
  readonly disputeState?: string;
  readonly pageSize?: number;
  readonly nextPageToken?: string;
}

export function listDisputes(http: PayPalHttp, input: ListDisputesInput = {}): Promise<PayPalResponse<DisputeList>> {
  const query: Record<string, string> = {};
  if (input.disputedTransactionId !== undefined) query.disputed_transaction_id = input.disputedTransactionId;
  if (input.startTime !== undefined) query.start_time = input.startTime;
  if (input.disputeState !== undefined) query.dispute_state = input.disputeState;
  if (input.pageSize !== undefined) query.page_size = String(input.pageSize);
  if (input.nextPageToken !== undefined) query.next_page_token = input.nextPageToken;
  return http.get(DISPUTES_PATH, DisputeListSchema, { query });
}

export interface DisputeView {
  readonly dispute: Dispute;
  /** Actions PayPal allows right now (see disputeActions). */
  readonly actions: string[];
  readonly debugId: string | null;
}

export async function getDispute(http: PayPalHttp, disputeId: string): Promise<DisputeView> {
  const response = await http.get(`${DISPUTES_PATH}/${seg(disputeId)}`, DisputeSchema);
  return { dispute: response.data, actions: disputeActions(response.data.links), debugId: response.debugId };
}

// ---------------------------------------------------------------------------------------------
// Answer: provide-evidence (multipart) and accept-claim (JSON)

/** File rules from PayPal's "Supported file types and sizes" page. */
export const EVIDENCE_FILE_TYPES = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/gif": ["gif"],
} as const;
export type EvidenceContentType = keyof typeof EVIDENCE_FILE_TYPES;
/** "Less than 10 MB per file", "up to 50 MB per API call". */
export const MAX_EVIDENCE_FILE_BYTES = 10 * 1024 * 1024 - 1;
export const MAX_EVIDENCE_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_NOTES_LENGTH = 2000;
// Document-name pattern from the Disputes v1 `document.name` schema.
const DOCUMENT_NAME_RE = /^[A-Za-z0-9\-_,\s]+[.][A-Za-z]+$/;

export interface EvidenceInput {
  /** e.g. PROOF_OF_FULFILLMENT, PROOF_OF_REFUND, OTHER (Disputes v1 evidence_type). */
  readonly evidenceType: string;
  readonly notes?: string;
  /** tracking_info / refund_ids, passed through as PayPal documents them. */
  readonly evidenceInfo?: Readonly<Record<string, unknown>>;
}

export interface EvidenceFile {
  readonly filename: string;
  readonly contentType: EvidenceContentType;
  readonly data: Uint8Array;
}

function checkNotes(notes: string): string {
  if (notes.trim() === "" || notes.length > MAX_NOTES_LENGTH) throw new TypeError(`notes must be 1-${MAX_NOTES_LENGTH} chars`);
  return notes;
}

function checkEvidenceFile(file: EvidenceFile): void {
  if (!DOCUMENT_NAME_RE.test(file.filename)) throw new TypeError(`evidence filename ${JSON.stringify(file.filename)} must look like name.ext (letters, digits, - _ , space)`);
  const extension = file.filename.slice(file.filename.lastIndexOf(".") + 1).toLowerCase();
  const allowed: readonly string[] = EVIDENCE_FILE_TYPES[file.contentType];
  if (!allowed.includes(extension)) throw new TypeError(`${file.filename}: extension does not match ${file.contentType}`);
  if (file.data.byteLength === 0) throw new TypeError(`${file.filename} is empty`);
  if (file.data.byteLength > MAX_EVIDENCE_FILE_BYTES) throw new RangeError(`${file.filename} must be under 10 MB`);
}

export interface ProvideEvidenceInput {
  readonly disputeId: string;
  readonly evidences: readonly EvidenceInput[];
  readonly files?: readonly EvidenceFile[];
  /** Evidence may be requested more than once per dispute, so the caller names each submission. */
  readonly requestId: string;
}

/** The JSON `input` part plus one part per file, named file1..fileN as in PayPal's curl sample. */
export function buildProvideEvidenceParts(input: Pick<ProvideEvidenceInput, "evidences" | "files">): MultipartPart[] {
  if (input.evidences.length === 0 || input.evidences.length > 100) throw new RangeError("provide 1-100 evidences");
  const evidences = input.evidences.map((e) => {
    if (!/^[A-Z0-9_]{1,255}$/.test(e.evidenceType)) throw new TypeError(`invalid evidence_type ${JSON.stringify(e.evidenceType)}`);
    return {
      evidence_type: e.evidenceType,
      ...(e.evidenceInfo === undefined ? {} : { evidence_info: e.evidenceInfo }),
      ...(e.notes === undefined ? {} : { notes: checkNotes(e.notes) }),
    };
  });
  const files = input.files ?? [];
  files.forEach(checkEvidenceFile);
  const total = files.reduce((sum, f) => sum + f.data.byteLength, 0);
  if (total > MAX_EVIDENCE_TOTAL_BYTES) throw new RangeError("evidence files must total at most 50 MB per call");
  return [
    { name: "input", contentType: "application/json", data: JSON.stringify({ evidences }) },
    ...files.map((file, i) => ({ name: `file${i + 1}`, filename: file.filename, contentType: file.contentType, data: file.data })),
  ];
}

/** POST /v1/customer/disputes/{id}/provide-evidence (needs status WAITING_FOR_SELLER_RESPONSE). */
export function provideEvidence(client: PayPalMultipartClient, input: ProvideEvidenceInput): Promise<PayPalResponse<SubsequentAction>> {
  const parts = buildProvideEvidenceParts(input);
  return client.post(`${DISPUTES_PATH}/${seg(input.disputeId)}/provide-evidence`, parts, SubsequentActionSchema, { requestId: input.requestId });
}

export interface AcceptClaimInput {
  readonly disputeId: string;
  readonly note: string;
  /** REFUND (default on PayPal's side), REFUND_WITH_RETURN, PARTIAL_REFUND, ... per allowed_response_options. */
  readonly acceptClaimType?: string;
  readonly acceptClaimReason?: string;
  readonly invoiceId?: string;
  /** Default "<dispute_id>:accept-claim": accepting is one-shot, so a retry must replay. */
  readonly requestId?: string;
}

export function buildAcceptClaimRequest(input: Omit<AcceptClaimInput, "disputeId" | "requestId">): Record<string, string> {
  return {
    note: checkNotes(input.note),
    ...(input.acceptClaimType === undefined ? {} : { accept_claim_type: input.acceptClaimType }),
    ...(input.acceptClaimReason === undefined ? {} : { accept_claim_reason: input.acceptClaimReason }),
    ...(input.invoiceId === undefined ? {} : { invoice_id: input.invoiceId }),
  };
}

/** POST /v1/customer/disputes/{id}/accept-claim: closes in the buyer's favour; PayPal refunds from the merchant. */
export function acceptClaim(http: PayPalHttp, input: AcceptClaimInput): Promise<PayPalResponse<SubsequentAction>> {
  return http.post(`${DISPUTES_PATH}/${seg(input.disputeId)}/accept-claim`, buildAcceptClaimRequest(input), SubsequentActionSchema, {
    requestId: input.requestId ?? `${input.disputeId}:accept-claim`,
  });
}

export interface EscalateInput {
  readonly disputeId: string;
  readonly note: string;
  /** Default "<dispute_id>:escalate": a dispute is escalated at most once. */
  readonly requestId?: string;
}

/**
 * POST /v1/customer/disputes/{id}/escalate: the merchant turns an INQUIRY into a PayPal claim
 * (stage must be INQUIRY). A claim is what PayPal reviews, so in the sandbox this is the step that
 * makes require-evidence and adjudicate available for a dispute the buyer opened in the UI.
 */
export function escalateDispute(http: PayPalHttp, input: EscalateInput): Promise<PayPalResponse<SubsequentAction>> {
  return http.post(`${DISPUTES_PATH}/${seg(input.disputeId)}/escalate`, { note: checkNotes(input.note) }, SubsequentActionSchema, {
    requestId: input.requestId ?? `${input.disputeId}:escalate`,
  });
}

// ---------------------------------------------------------------------------------------------
// Sandbox-only simulation (Disputes "Test and go live" page)

function assertSandboxOnly(config: PayPalConfig, what: string): void {
  try {
    assertSandbox(config);
  } catch (error) {
    throw new PayPalConfigError(`${what} is a sandbox-only PayPal endpoint; refusing to call it outside the sandbox`, { cause: error });
  }
}

/**
 * PayPal-Auth-Assertion for acting as the sandbox buyer: an unsigned JWT (alg "none") with the
 * merchant app's client id as `iss` and the buyer's sandbox email, exactly as PayPal's generator
 * builds it (but with standard base64url).
 */
export function buildBuyerAuthAssertion(clientId: string, buyerEmail: string): string {
  if (clientId.trim() === "") throw new TypeError("clientId must be non-empty");
  if (!/^[^\s@]+@[^\s@]+$/.test(buyerEmail)) throw new TypeError("buyerEmail must be an email address (PAYPAL_SANDBOX_BUYER_EMAIL)");
  const header = toBase64Url(utf8(JSON.stringify({ alg: "none", typ: "JWT" })));
  const payload = toBase64Url(utf8(JSON.stringify({ iss: clientId, email: buyerEmail })));
  return `${header}.${payload}.`;
}

export type DisputedTransactionRef = { readonly buyerTransactionId: string } | { readonly sellerTransactionId: string };

export interface CreateSandboxDisputeInput {
  readonly buyerEmail: string;
  /** PayPal documents buyer_transaction_id (the id in the buyer's sandbox activity). */
  readonly transaction: DisputedTransactionRef;
  /** e.g. MERCHANDISE_OR_SERVICE_NOT_RECEIVED, MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED, UNAUTHORISED. */
  readonly reason: string;
  /** At most the transaction amount. */
  readonly amountMinor: bigint;
  readonly currency: Currency;
  readonly requestId: string;
}

export function buildCreateSandboxDisputeRequest(input: Omit<CreateSandboxDisputeInput, "buyerEmail" | "requestId">): Record<string, unknown> {
  if (input.amountMinor <= 0n) throw new RangeError("dispute amount must be positive");
  if (!/^[A-Z_]{1,255}$/.test(input.reason)) throw new TypeError(`invalid dispute reason ${JSON.stringify(input.reason)}`);
  const transaction =
    "buyerTransactionId" in input.transaction
      ? { buyer_transaction_id: input.transaction.buyerTransactionId }
      : { seller_transaction_id: input.transaction.sellerTransactionId };
  return {
    disputed_transactions: [transaction],
    reason: input.reason,
    dispute_amount: { currency_code: input.currency, value: minorToPayPalValue(input.amountMinor, input.currency) },
    extensions: {
      merchant_contacted: true,
      merchant_contacted_outcome: "NO_RESPONSE",
      merchandize_dispute_properties: { issue_type: "PRODUCT" },
    },
  };
}

/**
 * SANDBOX ONLY. POST /v1/customer/disputes as the buyer (multipart `input` part + PayPal-Auth-Assertion).
 * PayPal requires the app scope https://uri.paypal.com/services/disputes/create, which only a PayPal
 * account manager can add, plus buyer consent via Log in with PayPal; without them this fails and the
 * dispute is created in the sandbox Resolution Center UI instead (plan §17 S2 fallback).
 */
export async function createSandboxDispute(
  client: PayPalMultipartClient,
  input: CreateSandboxDisputeInput,
): Promise<PayPalResponse<SubsequentAction> & { readonly disputeId: string | null }> {
  assertSandboxOnly(client.config, "create dispute");
  const parts: MultipartPart[] = [{ name: "input", contentType: "application/json", data: JSON.stringify(buildCreateSandboxDisputeRequest(input)) }];
  const response = await client.post(DISPUTES_PATH, parts, SubsequentActionSchema, {
    requestId: input.requestId,
    headers: { "PayPal-Auth-Assertion": buildBuyerAuthAssertion(client.config.clientId, input.buyerEmail) },
  });
  return { ...response, disputeId: disputeIdFromLinks(response.data.links) };
}

export type RequireEvidenceAction = "SELLER_EVIDENCE" | "BUYER_EVIDENCE";

/** SANDBOX ONLY. UNDER_REVIEW -> WAITING_FOR_SELLER_RESPONSE (SELLER_EVIDENCE) or ..._BUYER_RESPONSE. */
export function requireEvidence(
  http: PayPalHttp,
  input: { readonly disputeId: string; readonly action: RequireEvidenceAction; readonly requestId?: string },
): Promise<PayPalResponse<SubsequentAction>> {
  assertSandboxOnly(http.config, "require-evidence");
  return http.post(`${DISPUTES_PATH}/${seg(input.disputeId)}/require-evidence`, { action: input.action }, SubsequentActionSchema, {
    requestId: input.requestId ?? `${input.disputeId}:require-evidence:${input.action}`,
  });
}

export type AdjudicationOutcome = "SELLER_FAVOR" | "BUYER_FAVOR";

/** SANDBOX ONLY. Settles an UNDER_REVIEW dispute the way a PayPal agent would. */
export function adjudicate(
  http: PayPalHttp,
  input: { readonly disputeId: string; readonly outcome: AdjudicationOutcome; readonly requestId?: string },
): Promise<PayPalResponse<SubsequentAction>> {
  assertSandboxOnly(http.config, "adjudicate");
  return http.post(`${DISPUTES_PATH}/${seg(input.disputeId)}/adjudicate`, { adjudication_outcome: input.outcome }, SubsequentActionSchema, {
    requestId: input.requestId ?? `${input.disputeId}:adjudicate:${input.outcome}`,
  });
}
