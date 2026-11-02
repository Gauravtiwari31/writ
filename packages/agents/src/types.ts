// Contracts between the reference agents and the gateway's run runner (plan §8.3, decision 6).
// FROZEN for the parallel build; the agents stream implements Atlas, Scout and the page reader.
// An agent is untrusted by design: it holds only its agent key, reaches the gateway only through
// AgentApiClient (the public agent API), and never sees raw addresses, payees or amounts to set.
import type { Reader, ResolvedModel } from "@writ/ai";
import type { BuiltinAgentKind, RunEvent, RunFailureCode } from "@writ/core/api";
import type { AgentApiClient } from "./client";

export interface AgentRunContext {
  writId: string;
  /** What the user asked for (e.g. the hero: "pottery-themed gift for my sister, under $60"). */
  goal: string;
  /** Aborted by POST /v1/runs/:id/stop, the run timeout or gateway shutdown. */
  signal: AbortSignal;
  /** Persist and stream one timeline row (agent_run_events + SSE run.event). */
  emit(event: RunEvent): Promise<void>;
  /** Call before every model step: false = the global daily LLM budget is spent (fail with rate_limited). */
  consumeLlmCall(): Promise<boolean>;
}

export interface AgentRunResult {
  status: "SUCCEEDED" | "FAILED" | "CANCELLED";
  failure_code: RunFailureCode | null;
  failure_detail: string | null;
  /** The last purchase the agent checked out. */
  purchase_id: string | null;
  steps: number;
  tokens: number;
}

export interface ShoppingAgent {
  readonly kind: BuiltinAgentKind;
  run(context: AgentRunContext): Promise<AgentRunResult>;
}

export interface FetchedPage {
  url: string;
  status: number;
  /** Raw HTML, capped. UNTRUSTED. */
  html: string;
  fetched_at: string;
}

/**
 * Fetches pages for the read_page tool. It runs inside the gateway process, so it MUST refuse
 * non-http(s) URLs and private, loopback and link-local addresses (SSRF) except the allowed
 * fixture origins, cap size and time, and follow redirects only to allowed targets.
 */
export interface PageReader {
  read(url: string, signal?: AbortSignal): Promise<FetchedPage>;
}

export interface AtlasDeps {
  /** MODEL_AGENT list (AiRuntime.agentModels). */
  models: readonly ResolvedModel[];
  client: AgentApiClient;
  pageReader: PageReader;
  maxSteps?: number;
}

export interface ScoutDeps extends AtlasDeps {
  /** The quarantined Reader (AiRuntime.reader): the Planner never sees raw pages. */
  reader: Reader;
}
