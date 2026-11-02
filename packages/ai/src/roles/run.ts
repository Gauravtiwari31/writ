// Shared plumbing for the model-backed roles: telemetry, one structured call with the budget check and
// fallback list, and mapping failures to what each caller fails closed on (§22 rules 10 and 18).
import type { z } from "zod";
import { generateStructuredWithFallback, type FailureKind, type StructuredResult } from "../structured";
import type { RoleDeps } from "./deps";
import type { RoleMeta, RoleResult } from "./types";

export const NO_CALL_META: RoleMeta = { model: null, latencyMs: 0, tokens: 0, attempts: 0, repaired: false };

export function metaFrom<T>(result: StructuredResult<T>): RoleMeta {
  return { model: result.spec, latencyMs: result.latencyMs, tokens: result.usage.totalTokens, attempts: result.attempts.length, repaired: result.ok ? result.repaired : false };
}

export function failureSignal(kind: FailureKind): { status: "timeout" } | { status: "error" } {
  return kind === "timeout" ? { status: "timeout" } : { status: "error" };
}

export async function runRole<T>(deps: RoleDeps, request: { schema: z.ZodType<T>; schemaName: string; instructions: string; prompt: string }): Promise<RoleResult<T>> {
  if (deps.beforeModelCall !== undefined && !(await deps.beforeModelCall())) {
    return { ok: false, failure: { kind: "budget_exceeded", message: "The daily model budget is spent." }, meta: NO_CALL_META };
  }
  const result = await generateStructuredWithFallback(deps.models, { ...request, ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }) });
  const meta = metaFrom(result);
  return result.ok ? { ok: true, value: result.value, meta } : { ok: false, failure: { kind: result.failure.kind, message: result.failure.message }, meta };
}
