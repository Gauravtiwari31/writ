// WritBench case contract (plan §13). Cases live in evals/cases/*.json; the runner (bench stream)
// loads them with WritBenchCaseSchema. Attack cases name their category and injection channel;
// benign cases have neither, and must stay unblocked (FBR) and mostly unreviewed (RR).
import { z } from "zod";

export const ATTACK_CATEGORIES = ["UPS", "ADR", "PAY", "BUD", "SUB", "EXF", "DSP"] as const;
export const AttackCategorySchema = z.enum(ATTACK_CATEGORIES);
export type AttackCategory = z.infer<typeof AttackCategorySchema>;

/** visible text · HTML comment · CSS-hidden · alt/title attribute · JSON-LD · fake "system notice" · multi-turn. */
export const INJECTION_CHANNELS = ["visible", "html_comment", "css_hidden", "alt_title", "json_ld", "system_notice", "multi_turn"] as const;
export const InjectionChannelSchema = z.enum(INJECTION_CHANNELS);
export type InjectionChannel = z.infer<typeof InjectionChannelSchema>;

export const WritBenchCaseSchema = z
  .strictObject({
    id: z.string().regex(/^WB-(UPS|ADR|PAY|BUD|SUB|EXF|DSP|BEN)-\d{3}$/, "WB-<CAT>-<nnn>"),
    category: z.enum([...ATTACK_CATEGORIES, "BENIGN"]),
    /** A named Writ template the runner signs for the case (e.g. "pottery-gift-60"). */
    writ_ref: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    /** A fixture page under fixtures/ (e.g. "deals-outlet/coupons-hidden-upsell.html"). */
    fixture_ref: z.string().regex(/^[a-z0-9][a-z0-9./-]{0,127}$/).refine((ref) => !ref.includes(".."), "no parent segments"),
    channel: InjectionChannelSchema.nullable(),
    /** What the attacker wants (scored as "money moved for attacker goal" when it happens). */
    attacker_goal: z.string().min(1).max(300).nullable(),
    benign: z.boolean(),
  })
  .refine((c) => c.benign === (c.category === "BENIGN"), { message: "benign exactly when category is BENIGN", path: ["benign"] })
  .refine((c) => (c.benign ? c.channel === null && c.attacker_goal === null : c.channel !== null && c.attacker_goal !== null), {
    message: "attack cases need a channel and an attacker goal; benign cases have neither",
    path: ["channel"],
  })
  .refine((c) => c.id.startsWith(`WB-${c.benign ? "BEN" : c.category}-`), { message: "id prefix must match the category", path: ["id"] });
export type WritBenchCase = z.infer<typeof WritBenchCaseSchema>;

/** Plan §13 metrics; values come only from a committed run (evals/results), never typed in (§22 rule 24). */
export const METRIC_NAMES = ["AHR", "MMR", "FBR", "RR", "latency_p50_ms", "latency_p95_ms", "tokens_per_decision"] as const;
export type MetricName = (typeof METRIC_NAMES)[number];
