// Builds every AI role from MODEL_<ROLE> env lists (plan decision 7: no keys → the gateway still
// boots and each role is null/unavailable, so callers fail closed). Owned by the ai stream; the
// signature of createAiRuntime is frozen because the gateway's services.ts calls it.
import { ModelRouterError, resolveRoleModels, ROLES, type ResolvedModel, type ResolveOptions, type Role, type RouterEnv } from "../router";
import { createAnalyst } from "./analyst";
import { createCompiler } from "./compiler";
import { createReader } from "./reader";
import { createSentinel } from "./sentinel";
import type { AiRuntime, RoleStatus } from "./types";
import { createVerifier } from "./verifier";

export interface AiRuntimeOptions {
  /** MODEL_<ROLE> lists and provider keys (the gateway passes config.secrets.aiEnv()). */
  env: RouterEnv;
  /** Test seam: provider factories (e.g. AI SDK mock models). */
  factories?: ResolveOptions["factories"];
  now?: () => Date;
  /** The gateway passes its global daily LLM budget check (judge-mode limits). */
  beforeModelCall?: () => Promise<boolean>;
}

export interface ResolvedRoles {
  models: Readonly<Record<Role, readonly ResolvedModel[] | null>>;
  status: Readonly<Record<Role, RoleStatus>>;
  /** Why a role is "invalid" (no secrets: router messages name env vars, never values). */
  problems: Readonly<Partial<Record<Role, string>>>;
}

/** Resolves every role's model list without calling any model. Never throws for configuration problems. */
export function resolveAllRoles(options: AiRuntimeOptions): ResolvedRoles {
  const models = {} as Record<Role, readonly ResolvedModel[] | null>;
  const status = {} as Record<Role, RoleStatus>;
  const problems: Partial<Record<Role, string>> = {};
  for (const role of ROLES) {
    try {
      models[role] = resolveRoleModels(role, options.env, options.factories === undefined ? {} : { factories: options.factories });
      status[role] = "configured";
    } catch (error) {
      models[role] = null;
      if (error instanceof ModelRouterError && error.code === "ROLE_NOT_CONFIGURED") {
        status[role] = "unconfigured";
      } else {
        status[role] = "invalid";
        problems[role] = error instanceof Error ? error.message : String(error);
      }
    }
  }
  return { models, status, problems };
}

export function createAiRuntime(options: AiRuntimeOptions): AiRuntime {
  const { models, status } = resolveAllRoles(options);
  const shared = {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.beforeModelCall === undefined ? {} : { beforeModelCall: options.beforeModelCall }),
  };
  const deps = (list: readonly ResolvedModel[]) => ({ models: list, ...shared });
  return {
    compiler: models.compiler === null ? null : createCompiler(deps(models.compiler)),
    sentinel: createSentinel({
      models: models.sentinel,
      ...(options.beforeModelCall === undefined ? {} : { beforeModelCall: options.beforeModelCall }),
    }),
    verifier: models.verifier === null ? null : createVerifier(deps(models.verifier)),
    reader: models.reader === null ? null : createReader(deps(models.reader)),
    analyst: models.analyst === null ? null : createAnalyst(deps(models.analyst)),
    agentModels: models.agent,
    status,
  };
}
