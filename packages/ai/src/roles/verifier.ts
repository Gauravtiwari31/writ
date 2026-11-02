// Verifier (plan §8.5): the second key. It reads the signed Writ, the typed cart, typed ProductFacts with
// datamarked titles and sentinel booleans. It never sees raw pages or agent rationale (§22 rule 17). Any
// failure is a signal the combiner turns into REVIEW; the combiner also applies the confidence rules.
import { verifierOutputSchemaFor } from "@writ/core";
import { datamarkInstructions, wrapUntrusted } from "../datamark";
import type { RoleDeps } from "./deps";
import { failureSignal, NO_CALL_META, runRole } from "./run";
import type { Verifier } from "./types";

const INSTRUCTIONS = [
  "You are an independent checker in a payment safety system. Decide whether each cart line plausibly satisfies what the person signed.",
  datamarkInstructions(),
  "Answer with verdict APPROVE, REVIEW or BLOCK; item_findings with exactly one finding per cart line (product_ref, fit yes|unclear|no, a reason of at most 120 characters); and confidence from 0 to 1.",
  "Use fit no only when an item clearly does not match. Use fit unclear when you cannot tell. A flagged source is worth at least REVIEW.",
  "Answer only with the JSON schema.",
].join("\n");

export function createVerifier(deps: RoleDeps): Verifier {
  return {
    async verify(input) {
      const refs = input.cart.items.map((item) => item.product_ref);
      const facts = input.facts.map(({ title, ...fact }) => ({ ...fact, title_block: wrapUntrusted("merchant_title", title, { maxChars: 200 }) }));
      const lines = input.cart.items.map(({ title: _title, ...line }) => line);
      const prompt = JSON.stringify({
        signed_purpose: input.writ.purpose,
        item_constraints: input.writ.item_constraints,
        categories: input.writ.scope.categories,
        deliver_by: input.writ.deliver_by,
        cart: { lines, total_minor: input.cart.total_minor, currency: input.cart.currency, eta: input.cart.eta },
        facts,
        flagged_product_refs: input.flagged_product_refs,
        any_source_flagged: input.any_source_flagged,
      });
      const result = await runRole(deps, { schema: verifierOutputSchemaFor(refs), schemaName: "verifier", instructions: INSTRUCTIONS, prompt });
      if (result.ok) return { signal: { status: "ok", result: result.value }, meta: result.meta };
      if (result.failure.kind === "unavailable" || result.failure.kind === "budget_exceeded") return { signal: { status: "error" }, meta: NO_CALL_META };
      return { signal: failureSignal(result.failure.kind), meta: result.meta };
    },
  };
}
