// Scout (plan §8.3): a Planner that sees typed facts + datamarked titles only, and a quarantined
// Reader that turns raw pages into ProductFacts. STUB: the agents stream implements it; the
// signature is frozen.
import { NotImplementedError } from "@writ/core";
import type { ScoutDeps, ShoppingAgent } from "./types";

export function createScout(_deps: ScoutDeps): ShoppingAgent {
  return {
    kind: "scout",
    run: () => Promise.reject(new NotImplementedError("agents", "Scout.run")),
  };
}
