// Purchase saga (money stream: P0-5, P0-6, P0-8). STUB until the money stream lands: every method
// rejects with NotImplementedError, so no route can pretend a purchase happened. The exported
// factory signatures are frozen (services.ts calls them); the bodies and every other file under
// src/saga belong to the money stream.
import { NotImplementedError } from "@writ/core";
import type { JobRegistration, PurchaseSaga } from "../contracts/index";
import type { CoreServices } from "../deps";

const todo = (feature: string) => () => Promise.reject(new NotImplementedError("money", `PurchaseSaga.${feature}`));

export function createPurchaseSaga(_deps: CoreServices): PurchaseSaga {
  return {
    open: todo("open"),
    block: todo("block"),
    reserveAndAuthorize: todo("reserveAndAuthorize"),
    beginVerification: todo("beginVerification"),
    execute: todo("execute"),
    requestVoids: todo("requestVoids"),
    markDisputed: todo("markDisputed"),
    resolveDispute: todo("resolveDispute"),
    get: todo("get"),
  };
}

/**
 * Job handlers for purchase.authorize | capture | void | refund, approval.expire, paypal.webhook,
 * and the periodic tasks (30 s recovery of AUTHORIZING/CAPTURING/VOIDING, approval timeouts).
 */
export function sagaJobs(_deps: CoreServices & { saga: PurchaseSaga }): JobRegistration {
  return { handlers: {}, periodic: [] };
}
