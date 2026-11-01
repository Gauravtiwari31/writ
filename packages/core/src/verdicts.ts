// Verdicts and the typed contracts of the two LLM stages that can only raise them (plan §6.2,
// §8.4, §8.5). Every LLM output is parsed with these schemas (§22 rule 18); anything that does not
// parse is a fail-closed REVIEW in the combiner, never a guess.
import { z } from "zod";
import { ProductRefSchema } from "./cart";
import { singleLineText } from "./writ";

/** Ascending severity: the combiner keeps the maximum (§22 rule 9). */
export const VERDICTS = ["APPROVE", "REVIEW", "BLOCK"] as const;
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

const SEVERITY: Readonly<Record<Verdict, number>> = { APPROVE: 0, REVIEW: 1, BLOCK: 2 };

/** 0 = APPROVE, 1 = REVIEW, 2 = BLOCK. Throws on anything else rather than ranking it below BLOCK. */
export function severity(verdict: Verdict): number {
  if (!Object.hasOwn(SEVERITY, verdict)) throw new TypeError(`unknown verdict: ${JSON.stringify(verdict)}`);
  return SEVERITY[verdict];
}

/** The most severe of the given verdicts (BLOCK > REVIEW > APPROVE). */
export function maxVerdict(first: Verdict, ...rest: readonly Verdict[]): Verdict {
  return rest.reduce((max, verdict) => (severity(verdict) > severity(max) ? verdict : max), first);
}

// ---------------------------------------------------------------------------------------------
// Sentinel (§8.4): classifies tainted inputs. Telemetry and defense in depth; a flag can only
// push a decision to REVIEW or higher.

/** Threat-model families (§9): T1 UPS, T2 ADR, T3 PAY, T4 BUD, T5 SUB, T6 EXF, T12 DSP. */
export const SENTINEL_CATEGORIES = ["UPS", "ADR", "PAY", "BUD", "SUB", "EXF", "DSP", "OTHER", "NONE"] as const;
export const SentinelCategorySchema = z.enum(SENTINEL_CATEGORIES);
export type SentinelCategory = z.infer<typeof SentinelCategorySchema>;

export const SENTINEL_CATEGORY_LABELS: Readonly<Record<SentinelCategory, string>> = {
  UPS: "Upsell injection",
  ADR: "Address swap",
  PAY: "Payee swap",
  BUD: "Budget escalation",
  SUB: "Substitution or knock-off",
  EXF: "Data exfiltration",
  DSP: "Dispute-message injection",
  OTHER: "Other injection",
  NONE: "No injection",
};

/**
 * Which extracted text a span's offsets index into. HTML pre-processing yields the visible and the
 * hidden text of a page separately (hidden = comments, script/style, CSS-hidden, aria-hidden,
 * alt/title attributes, JSON-LD); listings and search results add the product title and description.
 */
export const SENTINEL_CHANNELS = ["visible", "hidden", "title", "description"] as const;
export const SentinelChannelSchema = z.enum(SENTINEL_CHANNELS);
export type SentinelChannel = z.infer<typeof SentinelChannelSchema>;

export const SentinelSpanSchema = z
  .strictObject({
    /** UTF-16 offsets into the channel text, end exclusive. */
    start: z.int().min(0),
    end: z.int().min(0),
    /** UNTRUSTED quote of the span (capped): shown in red in the UI, never fed to a privileged prompt. */
    text: z.string().min(1).max(200),
    channel: SentinelChannelSchema,
  })
  .refine((span) => span.end > span.start, { message: "end must be after start", path: ["end"] });
export type SentinelSpan = z.infer<typeof SentinelSpanSchema>;

export const SentinelOutputSchema = z
  .strictObject({
    is_injection: z.boolean(),
    category: SentinelCategorySchema,
    score: z.number().min(0).max(1),
    spans: z.array(SentinelSpanSchema).max(20),
  })
  // A flag without a family (or a family without a flag) is a confused answer: repair or fail closed.
  .refine((out) => out.is_injection === (out.category !== "NONE"), {
    message: "category must be NONE exactly when is_injection is false",
    path: ["category"],
  });
export type SentinelOutput = z.infer<typeof SentinelOutputSchema>;

// ---------------------------------------------------------------------------------------------
// Verifier (§8.5): judges semantic fit from typed fields only (no raw pages, no agent rationale).

export const ITEM_FITS = ["yes", "unclear", "no"] as const;
export const ItemFitSchema = z.enum(ITEM_FITS);
export type ItemFit = z.infer<typeof ItemFitSchema>;

export const ItemFindingSchema = z.strictObject({
  product_ref: ProductRefSchema,
  fit: ItemFitSchema,
  reason: singleLineText(120),
});
export type ItemFinding = z.infer<typeof ItemFindingSchema>;

/** Below this the combiner asks a human whatever the verdict (§8.5). */
export const VERIFIER_MIN_CONFIDENCE = 0.7;

export const VerifierOutputSchema = z.strictObject({
  verdict: VerdictSchema,
  // A cart has 1-20 lines, and every line needs its own finding.
  item_findings: z
    .array(ItemFindingSchema)
    .min(1)
    .max(20)
    .refine((list) => new Set(list.map((f) => f.product_ref)).size === list.length, "one finding per product_ref"),
  confidence: z.number().min(0).max(1),
});
export type VerifierOutput = z.infer<typeof VerifierOutputSchema>;

/**
 * VerifierOutputSchema bound to one cart: exactly one finding per cart line, no invented lines.
 * Parse the model output with this, so a skipped item costs a repair retry instead of going unjudged.
 */
export function verifierOutputSchemaFor(productRefs: readonly string[]) {
  const expected = new Set(productRefs);
  return VerifierOutputSchema.superRefine((out, ctx) => {
    const seen = new Set(out.item_findings.map((f) => f.product_ref));
    out.item_findings.forEach((finding, i) => {
      if (!expected.has(finding.product_ref)) {
        ctx.addIssue({ code: "custom", path: ["item_findings", i, "product_ref"], message: "not a line of this cart" });
      }
    });
    // Refs are agent-supplied, so the repair prompt names the line by position, not by its ref.
    productRefs.forEach((ref, i) => {
      if (!seen.has(ref)) {
        ctx.addIssue({ code: "custom", path: ["item_findings"], message: `missing a finding for cart item ${i + 1}` });
      }
    });
  });
}
