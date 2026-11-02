// Dispute Analyst (plan §8.6): typed evidence facts + datamarked buyer messages → DisputeAnalysis.
// STUB: the ai stream implements it; the signature is frozen.
import { NotImplementedError } from "@writ/core";
import type { RoleDeps } from "./deps";
import type { Analyst } from "./types";

export function createAnalyst(_deps: RoleDeps): Analyst {
  return {
    analyze: () => Promise.reject(new NotImplementedError("ai", "Analyst.analyze")),
  };
}
