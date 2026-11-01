// Structured output with the §22 rule 18 contract: Zod-validated, at most one retry, then a
// typed failure the caller turns into REVIEW/BLOCK. This function never throws for model or
// transport problems, so a caller cannot forget to fail closed.
import {
  APICallError,
  generateText,
  JSONParseError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  RetryError,
  TypeValidationError,
  type LanguageModelUsage,
  type ModelMessage,
} from "ai";
import { z } from "zod";
import { errorMessage, safeErrorText } from "./redact";
import { DEFAULT_TEMPERATURE, ModelRouterError, type ProviderName, type ResolvedModel } from "./router";

/**
 * "schema": the provider enforces the JSON schema (native structured outputs).
 * "json": plain JSON mode with the schema described in the instructions; used when a provider
 * or model rejects the schema (e.g. Groq models without json_schema support).
 */
export type StructuredMode = "schema" | "json";

export type FailureKind =
  | "invalid_output"
  | "schema_rejected"
  | "rate_limited"
  | "auth"
  | "model_not_found"
  | "timeout"
  | "api_error"
  | "unknown";

export interface StructuredRequest<T> {
  model: ResolvedModel;
  schema: z.ZodType<T>;
  /** Passed to providers that name the output (schema/tool name). */
  schemaName?: string;
  instructions: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Total budget for one attempt, in ms. */
  timeoutMs?: number;
  /** AI SDK transport retries per attempt (429/5xx with backoff). 0 surfaces rate limits immediately. */
  maxRetries?: number;
  mode?: StructuredMode;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AttemptRecord {
  mode: StructuredMode;
  ok: boolean;
  latencyMs: number;
  kind?: FailureKind;
  statusCode?: number;
  /** Provider rate-limit headers (x-ratelimit-*, retry-after) when the provider sent any. */
  rateLimit?: Record<string, string>;
}

export interface StructuredFailure {
  kind: FailureKind;
  message: string;
  statusCode?: number;
}

interface ResultBase {
  provider: ProviderName;
  modelId: string;
  spec: string;
  attempts: AttemptRecord[];
  latencyMs: number;
  usage: TokenUsage;
}

export interface StructuredSuccess<T> extends ResultBase {
  ok: true;
  value: T;
  mode: StructuredMode;
  repaired: boolean;
  /** Model id the provider reports having served (may differ from the alias requested). */
  responseModelId?: string;
}

export interface StructuredFailureResult extends ResultBase {
  ok: false;
  failure: StructuredFailure;
}

export type StructuredResult<T> = StructuredSuccess<T> | StructuredFailureResult;

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

function toTokenUsage(usage: LanguageModelUsage | undefined): TokenUsage {
  if (usage === undefined) return ZERO_USAGE;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: usage.totalTokens ?? inputTokens + outputTokens };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

interface ClassifiedError extends StructuredFailure {
  /** Text the model produced, when there was any (used for the repair turn). */
  text?: string;
  usage: TokenUsage;
  rateLimit?: Record<string, string>;
}

/** Keeps only rate-limit headers; nothing else from a provider response is logged. */
export function pickRateLimitHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith("x-ratelimit-") || lower === "retry-after" || lower === "retry-after-ms") out[lower] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export function classifyModelError(error: unknown, mode: StructuredMode): ClassifiedError {
  const inner = RetryError.isInstance(error) ? error.lastError : error;
  const message = safeErrorText(errorMessage(inner));
  if (NoObjectGeneratedError.isInstance(inner)) {
    const cause = inner.cause === undefined ? message : safeErrorText(errorMessage(inner.cause), 400);
    return { kind: "invalid_output", message: cause, text: inner.text, usage: toTokenUsage(inner.usage) };
  }
  if (
    NoOutputGeneratedError.isInstance(inner) ||
    TypeValidationError.isInstance(inner) ||
    JSONParseError.isInstance(inner)
  ) {
    return { kind: "invalid_output", message, usage: ZERO_USAGE };
  }
  if (APICallError.isInstance(inner)) {
    const statusCode = inner.statusCode;
    const rateLimit = pickRateLimitHeaders(inner.responseHeaders);
    const base = {
      message,
      usage: ZERO_USAGE,
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(rateLimit === undefined ? {} : { rateLimit }),
    };
    if (statusCode === 429) return { kind: "rate_limited", ...base };
    if (statusCode === 401 || statusCode === 403) return { kind: "auth", ...base };
    if (statusCode === 404) return { kind: "model_not_found", ...base };
    if (statusCode === 408 || statusCode === 504) return { kind: "timeout", ...base };
    // A 400 against a native schema request is almost always "this model can't take that schema".
    if (statusCode === 400 && mode === "schema") return { kind: "schema_rejected", ...base };
    return { kind: "api_error", ...base };
  }
  if (isAbortLike(inner)) return { kind: "timeout", message, usage: ZERO_USAGE };
  return { kind: "unknown", message, usage: ZERO_USAGE };
}

/** JSON Schema text for json mode. Falls back to a note if the schema has unrepresentable parts. */
function schemaText(schema: z.ZodType): string {
  try {
    return JSON.stringify(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
  } catch {
    return "(schema not representable; follow the field descriptions in the instructions)";
  }
}

function zodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

type AttemptOutcome<T> =
  | { ok: true; value: T; usage: TokenUsage; responseModelId?: string; rateLimit?: Record<string, string> }
  | ({ ok: false } & ClassifiedError);

async function runAttempt<T>(
  request: StructuredRequest<T>,
  mode: StructuredMode,
  messages: ModelMessage[],
): Promise<AttemptOutcome<T>> {
  const common = {
    model: request.model.model,
    messages,
    temperature: request.temperature ?? DEFAULT_TEMPERATURE,
    maxRetries: request.maxRetries,
    timeout: request.timeoutMs,
    maxOutputTokens: request.maxOutputTokens,
  };
  try {
    if (mode === "schema") {
      const result = await generateText({
        ...common,
        instructions: request.instructions,
        output: Output.object({ schema: request.schema, name: request.schemaName }),
      });
      return {
        ok: true,
        value: result.output,
        usage: toTokenUsage(result.totalUsage),
        responseModelId: result.response.modelId,
        rateLimit: pickRateLimitHeaders(result.response.headers),
      };
    }
    const result = await generateText({
      ...common,
      instructions:
        `${request.instructions}\n\nReply with exactly one JSON object that conforms to this JSON Schema. ` +
        `No prose and no code fences.\n${schemaText(request.schema)}`,
      output: Output.json(),
    });
    const usage = toTokenUsage(result.totalUsage);
    const rateLimit = pickRateLimitHeaders(result.response.headers);
    const parsed = request.schema.safeParse(result.output);
    if (!parsed.success) {
      return {
        ok: false,
        kind: "invalid_output",
        message: safeErrorText(zodIssues(parsed.error), 400),
        text: result.text,
        usage,
        ...(rateLimit === undefined ? {} : { rateLimit }),
      };
    }
    return { ok: true, value: parsed.data, usage, responseModelId: result.response.modelId, rateLimit };
  } catch (error) {
    return { ok: false, ...classifyModelError(error, mode) };
  }
}

function repairMessages(prompt: string, badText: string | undefined, reason: string): ModelMessage[] {
  const correction =
    `Your previous reply was rejected: ${reason}. ` +
    "Reply again with only one JSON object that matches the required schema. No prose, no code fences.";
  if (badText === undefined || badText.trim() === "") {
    return [{ role: "user", content: `${prompt}\n\n${correction}` }];
  }
  return [
    { role: "user", content: prompt },
    { role: "assistant", content: badText.slice(0, 4000) },
    { role: "user", content: correction },
  ];
}

export async function generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
  const started = performance.now();
  const attempts: AttemptRecord[] = [];
  let usage = ZERO_USAGE;
  let mode: StructuredMode = request.mode ?? "schema";
  let messages: ModelMessage[] = [{ role: "user", content: request.prompt }];
  const base = { provider: request.model.provider, modelId: request.model.modelId, spec: request.model.spec };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptStart = performance.now();
    const outcome = await runAttempt(request, mode, messages);
    const latencyMs = performance.now() - attemptStart;
    usage = addUsage(usage, outcome.usage);

    const rateLimit = outcome.rateLimit === undefined ? {} : { rateLimit: outcome.rateLimit };
    if (outcome.ok) {
      attempts.push({ mode, ok: true, latencyMs, ...rateLimit });
      return {
        ...base,
        ok: true,
        value: outcome.value,
        mode,
        repaired: attempt > 1,
        attempts,
        latencyMs: performance.now() - started,
        usage,
        ...(outcome.responseModelId === undefined ? {} : { responseModelId: outcome.responseModelId }),
      };
    }

    attempts.push({
      mode,
      ok: false,
      latencyMs,
      kind: outcome.kind,
      ...(outcome.statusCode === undefined ? {} : { statusCode: outcome.statusCode }),
      ...rateLimit,
    });
    const failure: StructuredFailure = {
      kind: outcome.kind,
      message: outcome.message,
      ...(outcome.statusCode === undefined ? {} : { statusCode: outcome.statusCode }),
    };
    const canRetry = attempt === 1 && (outcome.kind === "invalid_output" || outcome.kind === "schema_rejected");
    if (!canRetry) {
      return { ...base, ok: false, failure, attempts, latencyMs: performance.now() - started, usage };
    }
    if (outcome.kind === "schema_rejected") {
      mode = "json";
      messages = [{ role: "user", content: request.prompt }];
    } else {
      messages = repairMessages(request.prompt, outcome.text, outcome.message);
    }
  }
  // Unreachable: the loop returns on every path of the second attempt.
  throw new Error("generateStructured: retry loop exited unexpectedly");
}

/** Failures that say nothing about the model's answer, so the next model in the list may try. */
const FAILOVER_KINDS: ReadonlySet<FailureKind> = new Set([
  "rate_limited",
  "auth",
  "model_not_found",
  "timeout",
  "api_error",
  "unknown",
]);

export type FallbackResult<T> = StructuredResult<T> & { tried: string[] };

/**
 * Walks a role's fallback list. Fails over only on transport-type errors: an invalid answer
 * after the repair retry fails closed instead of shopping for a model that agrees.
 */
export async function generateStructuredWithFallback<T>(
  models: readonly ResolvedModel[],
  request: Omit<StructuredRequest<T>, "model">,
): Promise<FallbackResult<T>> {
  if (models.length === 0) throw new ModelRouterError("EMPTY_LIST", "No models to try.");
  const tried: string[] = [];
  let last: StructuredResult<T> | undefined;
  for (const model of models) {
    tried.push(model.spec);
    last = await generateStructured({ ...request, model });
    if (last.ok || !FAILOVER_KINDS.has(last.failure.kind)) return { ...last, tried };
  }
  // models is non-empty, so last is set.
  return { ...(last as StructuredResult<T>), tried };
}
