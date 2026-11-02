// What every model-backed role factory receives. Owned by the ai stream together with the factories.
import type { ResolvedModel } from "../router";

export interface RoleDeps {
  /** The role's MODEL_<ROLE> fallback list (non-empty). */
  models: readonly ResolvedModel[];
  /** Injected clock for prompts that mention dates. */
  now?: () => Date;
  /** Per-attempt budget in ms (plan §6.8: verifier 20 s, then REVIEW). */
  timeoutMs?: number;
  /**
   * Called before every model request. false = the global daily LLM budget is spent: return a
   * failure of kind "budget_exceeded" (fail closed) without calling the model.
   */
  beforeModelCall?: () => Promise<boolean>;
}
