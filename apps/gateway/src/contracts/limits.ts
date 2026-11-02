// Judge-mode limits (plan §18; implemented by the judge stream in src/judge, backed by the
// rate_counters table so they survive restarts). The AI runtime consults tryConsumeLlmCall before
// every model request and fails closed when it returns false.
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md).

export interface RateLimits {
  /** Counts one hero run for the tenant in the current hour (DEMO_HERO_RUNS_PER_HOUR). */
  tryConsumeHeroRun(tenantId: string): Promise<{ allowed: boolean; remaining: number }>;
  heroRunsRemaining(tenantId: string): Promise<number>;
  /** Counts one LLM request against the global daily budget (DEMO_LLM_CALLS_PER_DAY); false = over budget. */
  tryConsumeLlmCall(): Promise<boolean>;
  llmCallsRemaining(): Promise<number>;
}
