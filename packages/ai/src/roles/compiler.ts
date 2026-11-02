// Intent Compiler (plan §8.2). STUB: the ai stream implements it with generateStructured +
// WritDraftSchema (one repair retry, then { ok: false }); the signature is frozen.
import { NotImplementedError } from "@writ/core";
import type { RoleDeps } from "./deps";
import type { Compiler } from "./types";

export function createCompiler(_deps: RoleDeps): Compiler {
  return {
    compile: () => Promise.reject(new NotImplementedError("ai", "Compiler.compile")),
  };
}
