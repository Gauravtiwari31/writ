// Atlas (plan §8.3): ONE LLM with the raw page text in its context and the tools get_writ,
// search_products, read_page, propose_cart and checkout. Deliberately naive: it stands for "any
// third-party agent" and is labeled "untrusted demo agent" everywhere. STUB: the agents stream
// implements the tool loop; the signature is frozen.
import { NotImplementedError } from "@writ/core";
import type { AtlasDeps, ShoppingAgent } from "./types";

export function createAtlas(_deps: AtlasDeps): ShoppingAgent {
  return {
    kind: "atlas",
    run: () => Promise.reject(new NotImplementedError("agents", "Atlas.run")),
  };
}
