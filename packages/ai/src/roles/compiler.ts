// Intent Compiler (plan §8.2): the user's own words → WritDraft. Never auto-signed: the user reviews the
// permission card and signs. Unknown categories or a missing budget become questions, never guesses.
import { CATEGORY_LEAVES, DENIABLE_KINDS, WritDraftSchema } from "@writ/core";
import type { RoleDeps } from "./deps";
import { runRole } from "./run";
import type { Compiler } from "./types";

const INSTRUCTIONS = [
  "You turn a person's shopping request into a structured spending permission draft for a payment safety system.",
  "Amounts are integer minor units as strings: $60 is \"6000\". Dates are YYYY-MM-DD.",
  `Categories come only from this list, or their parent before the dot: ${CATEGORY_LEAVES.join(", ")}. If nothing fits, leave categories null and ask in clarifying_questions.`,
  "If the budget is missing, leave total_minor null and ask. Never invent a budget. Ask at most two questions.",
  `deny_kinds defaults to all of: ${DENIABLE_KINDS.join(", ")}, unless the person explicitly asks otherwise.`,
  "\"ask me above $40\" means require_human_above_minor \"4000\". Use a ship_to_ref only from the given address list. List anything you assumed in assumptions.",
  "Answer only with the JSON schema.",
].join("\n");

export function createCompiler(deps: RoleDeps): Compiler {
  return {
    compile(input) {
      const prompt = JSON.stringify({ request: input.text, addresses: input.addresses, existing_writs: input.existing_writs, today: input.now.slice(0, 10) });
      return runRole(deps, { schema: WritDraftSchema, schemaName: "writ_draft", instructions: INSTRUCTIONS, prompt });
    },
  };
}
