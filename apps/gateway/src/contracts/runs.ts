// Built-in agent runs (plan decision 6; implemented by the agents stream in src/runs). A run is a
// background task inside the gateway process that drives Atlas or Scout from @writ/agents; the
// agent reaches the gateway ONLY through the public agent API (AgentApiClient against
// config.gatewayInternalUrl) with a fresh key minted for the run, exactly like an external agent.
// Every RunEvent is persisted (agent_run_events) and published as SSE run.event.
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md).
import type { BuiltinAgentKind, RunMode, RunView } from "@writ/core/api";

export interface StartRunInput {
  tenantId: string;
  userId: string;
  agentKind: BuiltinAgentKind;
  /** Must be ACTIVE and bound to this user's built-in agent of `agentKind`. */
  writId: string;
  /** Defaults to the Writ purpose. */
  goal?: string;
  mode: RunMode;
}

export interface AgentRunner {
  /**
   * Inserts the agent_runs row and starts the run in the background; resolves with the RunView
   * (status QUEUED/RUNNING). No MODEL_AGENT → the run is created and fails at once with
   * failure_code "ai_unavailable" (visible in the timeline), never a fake run.
   */
  start(input: StartRunInput): Promise<RunView>;
  /** Aborts a run of this tenant; resolves with its final view (CANCELLED). */
  stop(input: { tenantId: string; runId: string }): Promise<RunView>;
  /** server.ts at boot: runs left QUEUED/RUNNING by a dead process → FAILED (interrupted). */
  recoverOnStartup(): Promise<void>;
  /** server.ts on SIGTERM: abort running runs and wait for them to record their end. */
  shutdown(): Promise<void>;
}
