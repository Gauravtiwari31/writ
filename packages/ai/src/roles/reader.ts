// Scout's quarantined Reader (plan §8.3): raw page → ProductFacts, no tools, strict schema.
// STUB: the ai stream implements it; the signature is frozen.
import { NotImplementedError } from "@writ/core";
import type { RoleDeps } from "./deps";
import type { Reader } from "./types";

export function createReader(_deps: RoleDeps): Reader {
  return {
    read: () => Promise.reject(new NotImplementedError("ai", "Reader.read")),
  };
}
