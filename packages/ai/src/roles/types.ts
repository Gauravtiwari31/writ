// AI role contracts (plan §8.1). FROZEN for the parallel build: the gateway, the agents package and
// the evals depend on these shapes; the ai stream implements them behind the factories in this
// folder. Every role output is Zod-validated with one repair retry, then fails closed (§22 rule 18):
// a role never throws for model or transport problems, it returns { ok: false } (or, for the
// Sentinel and Verifier, a combiner signal with status "error"/"timeout"), and the caller maps that
// to REVIEW/BLOCK. No role has a tool or field that moves money (§22 rule 8).
import type {
  Cart,
  CartSource,
  DisputeAnalysis,
  ProductFacts,
  SentinelChannel,
  SentinelOutput,
  SentinelSignal,
  Verdict,
  VerifierSignal,
  WritBody,
  WritDraft,
} from "@writ/core";
import type { ResolvedModel, Role } from "../router";
import type { FailureKind } from "../structured";

/** Telemetry for decisions rows and docs/EVALS.md (model id, latency, tokens). */
export interface RoleMeta {
  /** "provider:model-id" that answered last; null when no model was called (rules only, unavailable). */
  model: string | null;
  latencyMs: number;
  tokens: number;
  attempts: number;
  repaired: boolean;
}

/** Beyond the transport kinds: no model configured, the global LLM budget is spent. */
export type RoleFailureKind = FailureKind | "unavailable" | "budget_exceeded";

export type RoleResult<T> =
  | { ok: true; value: T; meta: RoleMeta }
  | { ok: false; failure: { kind: RoleFailureKind; message: string }; meta: RoleMeta };

// ---- Intent Compiler (plan §8.2): user text → WritDraft. Privileged; sees user text only. -------

export interface CompileInput {
  /** The user's request, verbatim (trusted: the user's own words). */
  text: string;
  /** Address-book labels only; the compiler never sees street addresses. */
  addresses: readonly { ref: string; label: string }[];
  /** The user's existing Writs, for context ("another gift Writ?"). */
  existing_writs: readonly { purpose: string; status: string }[];
  /** ISO timestamp: resolves "by Nov 20" and default expiry. */
  now: string;
}

export interface Compiler {
  compile(input: CompileInput): Promise<RoleResult<WritDraft>>;
}

// ---- Sentinel (plan §8.4): rules + LLM classifier over every tainted input. -------------------

export interface SentinelInput {
  /** The tainted source as the agent declared it on the cart (carts.sources). */
  source: CartSource;
  /** Raw HTML of a page the gateway fetched, or listing text (title/description). UNTRUSTED. */
  content: { kind: "html"; html: string } | { kind: "text"; title: string | null; description: string | null };
}

/** A deterministic rule hit (offsets index into the channel text of the pre-processed page). */
export interface SentinelRuleHit {
  rule: string;
  channel: SentinelChannel;
  start: number;
  end: number;
  /** UNTRUSTED quote, capped at 200 chars. */
  text: string;
}

export interface SentinelScan {
  /** What the combiner reads. Without a classifier model this is { status: "error" } (fail closed → REVIEW). */
  signal: SentinelSignal;
  /** Deterministic hits; computed even when no model is configured. */
  rules: readonly SentinelRuleHit[];
  /** Spans for the attacks table and the red highlighting (rules ∪ classifier); null when nothing was flagged. */
  flagged: SentinelOutput | null;
  detector: "rules" | "llm" | "both" | null;
  /** HTML pre-processing split: what a human sees vs. what was hidden (comments, CSS-hidden, alt/title, JSON-LD ...). */
  stats: { visible_chars: number; hidden_chars: number };
  meta: RoleMeta;
}

export interface Sentinel {
  scan(input: SentinelInput): Promise<SentinelScan>;
}

// ---- Verifier (plan §8.5): typed fields only; NEVER raw pages or agent rationale (§22 rule 17). ----

export interface VerifierInput {
  writ: WritBody;
  cart: Cart;
  /** Typed facts per cart line (from the catalog, or Scout's Reader). Titles are datamarked in the prompt. */
  facts: readonly ProductFacts[];
  /** Cart lines whose contributing source the Sentinel flagged (booleans only, no page text). */
  flagged_product_refs: readonly string[];
  /** A flagged source shaped the whole cart (e.g. a coupon page). */
  any_source_flagged: boolean;
}

export interface VerifierRun {
  /** Parsed with verifierOutputSchemaFor(cart refs); timeout/parse failure → status "timeout"/"error". */
  signal: VerifierSignal;
  meta: RoleMeta;
}

export interface Verifier {
  verify(input: VerifierInput): Promise<VerifierRun>;
}

// ---- Scout Reader (plan §8.3): quarantined, no tools. Raw page → ProductFacts. ----------------

export interface ReaderInput {
  url: string;
  /** Raw page HTML. UNTRUSTED. */
  html: string;
  /** The product the Planner asked about, when known. */
  product_ref_hint: string | null;
}

export interface Reader {
  read(input: ReaderInput): Promise<RoleResult<ProductFacts>>;
}

// ---- Dispute Analyst (plan §8.6) ---------------------------------------------------------------

export interface AnalystInput {
  dispute: {
    paypal_dispute_id: string;
    reason: string | null;
    status: string;
    stage: string | null;
    amount_minor: string | null;
    currency: string | null;
    /** UNTRUSTED buyer messages: datamarked and capped before the prompt (§22 rule 16, threat T12). */
    buyer_messages: readonly string[];
  };
  /** Typed evidence-chain facts, computed by the gateway (never free text from the chain). */
  evidence: {
    writ_signed: boolean;
    signature_kind: "webauthn" | "device-ed25519" | null;
    /** The purpose the user signed (their own words). */
    purpose: string | null;
    human_approval: "approved" | "declined" | "not_required" | "none";
    verifier_verdict: Verdict | null;
    captured: boolean;
    /** Captured amount == committed cart total == policy amount. */
    amount_matches: boolean;
    fulfillment: "simulated" | "tracked" | "none";
    chain_verified: boolean;
  };
}

export interface Analyst {
  analyze(input: AnalystInput): Promise<RoleResult<DisputeAnalysis>>;
}

// ---- Runtime: what the gateway holds ----------------------------------------------------------

export type RoleStatus = "configured" | "unconfigured" | "invalid";

export interface AiRuntime {
  /** null without MODEL_COMPILER: POST /v1/writs/compile answers 503 ai_unavailable (manual editor). */
  compiler: Compiler | null;
  /** Always present: without MODEL_SENTINEL it runs the rules only and its signal is { status: "error" }. */
  sentinel: Sentinel;
  /** null without MODEL_VERIFIER: the pipeline records { status: "error" } and the combiner says REVIEW. */
  verifier: Verifier | null;
  /** null without MODEL_READER: Scout cannot run. */
  reader: Reader | null;
  /** null without MODEL_ANALYST: the dispute engine records ANALYST_UNAVAILABLE (ESCALATE_TO_HUMAN). */
  analyst: Analyst | null;
  /** MODEL_AGENT fallback list for the built-in agents; null = built-in runs fail with ai_unavailable. */
  agentModels: readonly ResolvedModel[] | null;
  /** Per role, for GET /v1/meta and logs. */
  status: Readonly<Record<Role, RoleStatus>>;
}
