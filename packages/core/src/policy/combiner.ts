// The monotonic combiner (plan §6.2 step 8): final = max(policy, threshold, sentinel, verifier)
// with BLOCK > REVIEW > APPROVE. LLM stages can only raise the result, never lower it (§22 rule 9).
// Fail closed (§22 rule 10): a missing, failed, timed-out or unparseable LLM answer counts as
// REVIEW, and a malformed policy decision counts as BLOCK. Every input is re-validated here, so a
// bug upstream can only make the decision stricter. Never throws for any input object.
import type { z } from "zod";
import {
  maxVerdict,
  SENTINEL_CATEGORY_LABELS,
  SentinelOutputSchema,
  VERIFIER_MIN_CONFIDENCE,
  verifierOutputSchemaFor,
  type SentinelOutput,
  type Verdict,
  type VerifierOutput,
} from "../verdicts";
import { POLICY_CHECK_IDS, PolicyDecisionSchema, THRESHOLD_CHECK_ID, type PolicyDecision, type PolicyReason } from "./decision";

export const DECISION_STAGES = ["policy", "threshold", "sentinel", "verifier"] as const;
export type DecisionStage = (typeof DECISION_STAGES)[number];

/** What an LLM stage hands the combiner. Its `result` is re-parsed here, so a raw model answer is safe. */
export type LlmSignal<T> = { status: "ok"; result: T } | { status: "error" } | { status: "timeout" };
export type SentinelSignal = LlmSignal<SentinelOutput>;
export type VerifierSignal = LlmSignal<VerifierOutput>;

export const COMBINER_REASON_CODES = [
  "POLICY_PASSED",
  "POLICY_BLOCKED",
  "POLICY_INVALID",
  "WITHIN_THRESHOLD",
  "REVIEW_THRESHOLD",
  "SENTINEL_MISSING",
  "SENTINEL_NO_SOURCES",
  "SENTINEL_ERROR",
  "SENTINEL_TIMEOUT",
  "SENTINEL_INVALID_OUTPUT",
  "SENTINEL_FLAGGED",
  "SENTINEL_CLEAN",
  "VERIFIER_MISSING",
  "VERIFIER_ERROR",
  "VERIFIER_TIMEOUT",
  "VERIFIER_INVALID_OUTPUT",
  "VERIFIER_APPROVE",
  "VERIFIER_REVIEW",
  "VERIFIER_BLOCK",
  "VERIFIER_LOW_CONFIDENCE",
  "VERIFIER_ITEM_MISFIT",
  "VERIFIER_ITEM_UNCLEAR",
  "VERIFIER_DISAGREEMENT",
] as const;
export type CombinerReasonCode = (typeof COMBINER_REASON_CODES)[number];

export interface StageContribution {
  stage: DecisionStage;
  verdict: Verdict;
  reason: { code: CombinerReasonCode; message: string };
}

export interface CombineInput {
  policy: PolicyDecision;
  /**
   * The cart's product_refs in line order. A Verifier answer must judge exactly these lines (one
   * finding each), or it is unusable: a skipped line is never treated as approved.
   */
  cart_product_refs: readonly string[];
  /**
   * One signal per scanned source (or a single signal). undefined = the scan never ran → REVIEW;
   * [] = the caller states no untrusted source shaped the cart, so there was nothing to scan.
   */
  sentinel?: SentinelSignal | readonly SentinelSignal[];
  /**
   * One signal, or several independent samples (§8.5 "stacker"; disagreement → REVIEW).
   * undefined or [] = the Verifier never ran → REVIEW.
   */
  verifier?: VerifierSignal | readonly VerifierSignal[];
}

export interface CombinedDecision {
  final: Verdict;
  /** Every judgment that went into `final`, in stage order; one row per stage signal and rule. */
  contributions: StageContribution[];
}

export interface PolicyPreview {
  /** Deterministic stages only. Sentinel and Verifier can still raise it at checkout, never lower it. */
  verdict: Verdict;
  contributions: StageContribution[];
  /** Empty once the policy blocks: no authorization is created, so no LLM stage runs. */
  pending_stages: ("sentinel" | "verifier")[];
}

const FAIL_CLOSED = "so a human must look (fail closed).";

const VERIFIER_VERDICT_CODES: Readonly<Record<Verdict, CombinerReasonCode>> = {
  APPROVE: "VERIFIER_APPROVE",
  REVIEW: "VERIFIER_REVIEW",
  BLOCK: "VERIFIER_BLOCK",
};

function contribution(stage: DecisionStage, verdict: Verdict, code: CombinerReasonCode, message: string): StageContribution {
  return { stage, verdict, reason: { code, message } };
}

function isList<T>(value: T | readonly T[]): value is readonly T[] {
  return Array.isArray(value);
}

/** undefined and null both mean "this stage never reported". */
function toList<T>(value: T | readonly T[] | undefined): readonly T[] | undefined {
  if (value === undefined || value === null) return undefined;
  return isList(value) ? value : [value];
}

function finalOf(contributions: readonly StageContribution[]): Verdict {
  return maxVerdict("APPROVE", ...contributions.map((c) => c.verdict));
}

type Reading<T> = { kind: "ok"; out: T } | { kind: "timeout" } | { kind: "error" } | { kind: "invalid" };

/** The envelope is not trusted either: a non-object or an unknown status counts as an error. */
function readSignal<T>(signal: unknown, schema: z.ZodType<T>): Reading<T> {
  if (typeof signal !== "object" || signal === null) return { kind: "error" };
  const { status, result } = signal as { status?: unknown; result?: unknown };
  if (status === "timeout") return { kind: "timeout" };
  if (status !== "ok") return { kind: "error" };
  const parsed = schema.safeParse(result);
  return parsed.success ? { kind: "ok", out: parsed.data } : { kind: "invalid" };
}

function isThresholdReason(reason: PolicyReason): boolean {
  return reason.check === THRESHOLD_CHECK_ID && reason.code === "REVIEW_THRESHOLD";
}

/**
 * Policy and threshold rows. The decision is not taken at its word: a malformed decision, a failed
 * or missing check, or any reason other than the threshold blocks even if `verdict` says
 * otherwise, and a REVIEW verdict is honored even without its reason.
 */
function deterministicStages(decision: PolicyDecision): { blocked: boolean; contributions: StageContribution[] } {
  const parsed = PolicyDecisionSchema.safeParse(decision);
  if (!parsed.success) {
    const message = "The policy decision is malformed, so the cart is blocked (fail closed).";
    return { blocked: true, contributions: [contribution("policy", "BLOCK", "POLICY_INVALID", message)] };
  }
  const policy = parsed.data;
  const blockers = new Set<string>([
    ...policy.checks.filter((check) => !check.passed).map((check) => check.id),
    ...POLICY_CHECK_IDS.filter((id) => !policy.checks.some((check) => check.id === id)),
    ...policy.reasons.filter((reason) => !isThresholdReason(reason)).map((reason) => reason.check),
  ]);
  if (policy.verdict === "BLOCK" || blockers.size > 0) {
    const message =
      blockers.size > 0 ? `The policy blocked this cart: ${[...blockers].join(", ")}.` : "The policy blocked this cart.";
    return { blocked: true, contributions: [contribution("policy", "BLOCK", "POLICY_BLOCKED", message)] };
  }
  const passed = contribution("policy", "APPROVE", "POLICY_PASSED", `All ${POLICY_CHECK_IDS.length} policy checks passed.`);
  const thresholdReason = policy.reasons.find(isThresholdReason);
  if (policy.verdict === "REVIEW" || thresholdReason !== undefined) {
    const message = thresholdReason?.message ?? "The policy asked for human approval.";
    return { blocked: false, contributions: [passed, contribution("threshold", "REVIEW", "REVIEW_THRESHOLD", message)] };
  }
  return {
    blocked: false,
    contributions: [passed, contribution("threshold", "APPROVE", "WITHIN_THRESHOLD", "The amount is within the human-approval threshold.")],
  };
}

function sentinelStage(signal: unknown): StageContribution {
  const reading = readSignal(signal, SentinelOutputSchema);
  switch (reading.kind) {
    case "timeout":
      return contribution("sentinel", "REVIEW", "SENTINEL_TIMEOUT", `The injection scan timed out, ${FAIL_CLOSED}`);
    case "error":
      return contribution("sentinel", "REVIEW", "SENTINEL_ERROR", `The injection scan failed, ${FAIL_CLOSED}`);
    case "invalid":
      return contribution("sentinel", "REVIEW", "SENTINEL_INVALID_OUTPUT", `The injection scan returned an unusable answer, ${FAIL_CLOSED}`);
    case "ok": {
      const out = reading.out;
      if (out.is_injection) {
        return contribution(
          "sentinel",
          "REVIEW",
          "SENTINEL_FLAGGED",
          `A source that shaped this cart looks like a prompt injection (${SENTINEL_CATEGORY_LABELS[out.category]}, score ${out.score}).`,
        );
      }
      return contribution("sentinel", "APPROVE", "SENTINEL_CLEAN", "No prompt injection found in a source that shaped this cart.");
    }
  }
}

function sentinelStages(signals: readonly unknown[] | undefined, policyBlocked: boolean): StageContribution[] {
  if (signals === undefined) {
    return policyBlocked ? [] : [contribution("sentinel", "REVIEW", "SENTINEL_MISSING", `The injection scan did not run, ${FAIL_CLOSED}`)];
  }
  if (signals.length === 0) {
    return [contribution("sentinel", "APPROVE", "SENTINEL_NO_SOURCES", "No untrusted source shaped this cart, so there was nothing to scan.")];
  }
  return signals.map((signal) => sentinelStage(signal));
}

/**
 * §8.5 rules: its own verdict, confidence < 0.7 → REVIEW, fit "unclear" → REVIEW, fit "no" → BLOCK.
 * Lines are named by position: product_refs are agent-supplied text.
 */
function judgeVerifier(out: VerifierOutput, refs: readonly string[]): StageContribution[] {
  const rows = [
    contribution("verifier", out.verdict, VERIFIER_VERDICT_CODES[out.verdict], `The Verifier returned ${out.verdict} with confidence ${out.confidence}.`),
  ];
  if (out.confidence < VERIFIER_MIN_CONFIDENCE) {
    rows.push(
      contribution(
        "verifier",
        "REVIEW",
        "VERIFIER_LOW_CONFIDENCE",
        `Verifier confidence ${out.confidence} is below ${VERIFIER_MIN_CONFIDENCE}, so a human must look.`,
      ),
    );
  }
  for (const finding of out.item_findings) {
    const line = refs.indexOf(finding.product_ref) + 1;
    if (finding.fit === "no") {
      rows.push(
        contribution("verifier", "BLOCK", "VERIFIER_ITEM_MISFIT", `The Verifier found that cart item ${line} does not fit this Writ: ${finding.reason}`),
      );
    } else if (finding.fit === "unclear") {
      rows.push(
        contribution(
          "verifier",
          "REVIEW",
          "VERIFIER_ITEM_UNCLEAR",
          `The Verifier could not tell whether cart item ${line} fits this Writ: ${finding.reason}`,
        ),
      );
    }
  }
  return rows;
}

function verifierStages(signals: readonly unknown[] | undefined, refs: readonly string[], policyBlocked: boolean): StageContribution[] {
  if (signals === undefined || signals.length === 0) {
    return policyBlocked ? [] : [contribution("verifier", "REVIEW", "VERIFIER_MISSING", `The Verifier did not run, ${FAIL_CLOSED}`)];
  }
  const schema = verifierOutputSchemaFor(refs);
  const rows: StageContribution[] = [];
  const verdicts = new Set<Verdict>();
  for (const signal of signals) {
    const reading = readSignal(signal, schema);
    switch (reading.kind) {
      case "timeout":
        rows.push(contribution("verifier", "REVIEW", "VERIFIER_TIMEOUT", `The Verifier timed out, ${FAIL_CLOSED}`));
        break;
      case "error":
        rows.push(contribution("verifier", "REVIEW", "VERIFIER_ERROR", `The Verifier failed, ${FAIL_CLOSED}`));
        break;
      case "invalid":
        rows.push(contribution("verifier", "REVIEW", "VERIFIER_INVALID_OUTPUT", `The Verifier returned an unusable answer, ${FAIL_CLOSED}`));
        break;
      case "ok":
        rows.push(...judgeVerifier(reading.out, refs));
        verdicts.add(reading.out.verdict);
        break;
    }
  }
  if (verdicts.size > 1) {
    rows.push(contribution("verifier", "REVIEW", "VERIFIER_DISAGREEMENT", "Independent Verifier samples disagree, so a human must look."));
  }
  return rows;
}

/** Only a list of strings can name cart lines; anything else judges no line, so every answer is unusable. */
function cartRefs(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((ref) => typeof ref === "string") ? (value as string[]) : [];
}

/** Stage 8. A policy BLOCK is final: max() keeps it whatever the LLM stages say. */
export function combineDecision(input: CombineInput): CombinedDecision {
  const { blocked, contributions } = deterministicStages(input.policy);
  contributions.push(
    ...sentinelStages(toList(input.sentinel), blocked),
    ...verifierStages(toList(input.verifier), cartRefs(input.cart_product_refs), blocked),
  );
  return { final: finalOf(contributions), contributions };
}

/** The cart-propose preview (§6.6 POST /v1/agent/carts): policy and threshold only, no LLM yet. */
export function previewVerdict(policy: PolicyDecision): PolicyPreview {
  const { blocked, contributions } = deterministicStages(policy);
  return { verdict: finalOf(contributions), contributions, pending_stages: blocked ? [] : ["sentinel", "verifier"] };
}
