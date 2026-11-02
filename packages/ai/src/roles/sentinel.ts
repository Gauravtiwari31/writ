// Sentinel (plan §8.4): HTML pre-processing (visible vs hidden text), deterministic rules and,
// when a model is configured, the datamarked LLM classifier. STUB: the ai stream implements it;
// the signature is frozen. With models = null it must still run the rules and return
// signal { status: "error" } so the combiner fails closed to REVIEW.
import { NotImplementedError } from "@writ/core";
import type { ResolvedModel } from "../router";
import type { Sentinel } from "./types";

export interface SentinelDeps {
  /** MODEL_SENTINEL list, or null when unconfigured (rules only). */
  models: readonly ResolvedModel[] | null;
  timeoutMs?: number;
  /** Consulted before the classifier call only; the rules never consume the LLM budget. */
  beforeModelCall?: () => Promise<boolean>;
}

export function createSentinel(_deps: SentinelDeps): Sentinel {
  return {
    scan: () => Promise.reject(new NotImplementedError("ai", "Sentinel.scan")),
  };
}
