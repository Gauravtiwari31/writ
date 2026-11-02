// The read_page tool fetcher. STUB: the agents stream implements it with the SSRF rules in the
// PageReader contract (types.ts); the signature is frozen.
import { NotImplementedError } from "@writ/core";
import type { PageReader } from "./types";

export interface PageReaderOptions {
  /** Origins allowed even when they resolve to loopback (the Wallet /fixtures route in local runs). */
  allowedOrigins: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
}

export function createPageReader(_options: PageReaderOptions): PageReader {
  return {
    read: () => Promise.reject(new NotImplementedError("agents", "PageReader.read")),
  };
}
