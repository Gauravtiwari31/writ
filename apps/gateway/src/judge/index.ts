// Judge-mode limits (judge stream, plan §18), backed by rate_counters. STUB until the judge
// stream lands: it ALLOWS everything (no limits exist yet, which is today's behavior), so other
// streams can develop; the factory signature is frozen (services.ts calls it).
import type { RateLimits } from "../contracts/index";
import type { CoreServices } from "../deps";

export function createRateLimits(deps: Pick<CoreServices, "config" | "db" | "clock" | "log">): RateLimits {
  const perHour = deps.config.judge.heroRunsPerHour;
  const perDay = deps.config.judge.llmCallsPerDay;
  return {
    tryConsumeHeroRun: () => Promise.resolve({ allowed: true, remaining: perHour }),
    heroRunsRemaining: () => Promise.resolve(perHour),
    tryConsumeLlmCall: () => Promise.resolve(true),
    llmCallsRemaining: () => Promise.resolve(perDay),
  };
}
