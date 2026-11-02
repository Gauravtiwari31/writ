// Built-in agent runs (agents stream, plan decision 6). STUB until the agents stream lands; the
// factory signature is frozen (services.ts calls it).
import { NotImplementedError } from "@writ/core";
import type { AgentRunner } from "../contracts/index";
import type { CoreServices } from "../deps";

export function createAgentRunner(_deps: CoreServices): AgentRunner {
  return {
    start: () => Promise.reject(new NotImplementedError("agents", "AgentRunner.start")),
    stop: () => Promise.reject(new NotImplementedError("agents", "AgentRunner.stop")),
    recoverOnStartup: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}
