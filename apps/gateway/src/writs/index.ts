// Writ lifecycle jobs (api stream, P0-1): the periodic expiry sweep (ACTIVE past expires_at →
// EXPIRED + WRIT_EXPIRED, then saga.requestVoids with writ_expired). STUB until the api stream
// lands; the factory signature is frozen (services.ts calls it).
import type { JobRegistration, PurchaseSaga } from "../contracts/index";
import type { CoreServices } from "../deps";

export function writJobs(_deps: CoreServices & { saga: PurchaseSaga }): JobRegistration {
  return { handlers: {}, periodic: [] };
}
