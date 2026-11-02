// The outbox poller (money stream, plan decision 3): claims due outbox rows with FOR UPDATE SKIP
// LOCKED under a lease (locked_until), dispatches by topic to the registered handlers, retries
// with backoff, marks rows published or dead, and runs the periodic tasks. STUB until the money
// stream lands: start() only logs; the factory signature is frozen (services.ts calls it).
import { NotImplementedError } from "@writ/core";
import type { JobRegistration, JobRunner } from "../contracts/index";
import type { CoreServices } from "../deps";

export interface JobRunnerDeps extends CoreServices {
  readonly registrations: readonly JobRegistration[];
}

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  return {
    start() {
      deps.log.warn("outbox job runner is not implemented yet (owner: money stream); outbox rows stay queued");
    },
    stop: () => Promise.resolve(),
    kick() {},
    runDue: () => Promise.reject(new NotImplementedError("money", "JobRunner.runDue")),
  };
}
