// Verifier (plan §8.5): typed cart + ProductFacts + datamarked titles + sentinel booleans, never raw
// pages or agent rationale. STUB: the ai stream implements it; the signature is frozen.
import { NotImplementedError } from "@writ/core";
import type { RoleDeps } from "./deps";
import type { Verifier } from "./types";

export function createVerifier(_deps: RoleDeps): Verifier {
  return {
    verify: () => Promise.reject(new NotImplementedError("ai", "Verifier.verify")),
  };
}
