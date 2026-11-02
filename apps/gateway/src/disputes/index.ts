// Dispute engine jobs (evidence stream, P0-9): dispute.sync and dispute.execute handlers. STUB
// until the evidence stream lands; the factory signature is frozen (services.ts calls it).
import type { JobRegistration, PurchaseSaga } from "../contracts/index";
import type { CoreServices } from "../deps";

export function disputeJobs(_deps: CoreServices & { saga: PurchaseSaga }): JobRegistration {
  return { handlers: {}, periodic: [] };
}
