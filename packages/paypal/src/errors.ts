// Every failure carries the method, path and PayPal-Debug-Id so it can be logged into the ledger
// and quoted in the PayPal Discord (§22 rules 6 and 43). None of them ever carries a token.
import { z } from "zod";

export type HttpMethod = "GET" | "POST" | "DELETE";

export interface PayPalErrorDetail {
  readonly issue: string | undefined;
  readonly field: string | undefined;
  readonly value: string | undefined;
  readonly location: string | undefined;
  readonly description: string | undefined;
}

/** Base class: catch this to handle any failure of a PayPal call. */
export class PayPalError extends Error {
  constructor(
    message: string,
    readonly method: HttpMethod,
    readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** PayPal answered with a non-2xx status. `name` is PayPal's error name (e.g. UNPROCESSABLE_ENTITY). */
export class PayPalApiError extends PayPalError {
  override readonly name: string;
  readonly status: number;
  readonly debugId: string | null;
  /** PayPal's own message, without our method/path/debug-id decoration. */
  readonly paypalMessage: string;
  readonly details: readonly PayPalErrorDetail[];

  constructor(init: {
    method: HttpMethod;
    path: string;
    status: number;
    name: string;
    paypalMessage: string;
    details: readonly PayPalErrorDetail[];
    debugId: string | null;
  }) {
    const issues = init.details.map((d) => d.issue).filter((issue): issue is string => issue !== undefined);
    const issueText = issues.length > 0 ? ` [${issues.join(", ")}]` : "";
    super(
      `${init.method} ${init.path} -> ${init.status} ${init.name}: ${init.paypalMessage}${issueText} (PayPal-Debug-Id ${init.debugId ?? "none"})`,
      init.method,
      init.path,
    );
    this.name = init.name;
    this.status = init.status;
    this.debugId = init.debugId;
    this.paypalMessage = init.paypalMessage;
    this.details = init.details;
  }

  get issues(): string[] {
    return this.details.map((d) => d.issue).filter((issue): issue is string => issue !== undefined);
  }

  hasIssue(issue: string): boolean {
    return this.issues.includes(issue);
  }
}

/**
 * The request did not finish within the timeout. For a POST the outcome is UNKNOWN: PayPal may have
 * acted. Retry with the same PayPal-Request-Id (idempotent) or re-read the resource; never assume failure.
 */
export class PayPalTimeoutError extends PayPalError {
  override readonly name = "PayPalTimeoutError";
  readonly outcomeUnknown = true;

  constructor(
    method: HttpMethod,
    path: string,
    readonly timeoutMs: number,
    options?: { cause?: unknown },
  ) {
    super(`${method} ${path} timed out after ${timeoutMs} ms (outcome unknown; retry with the same PayPal-Request-Id)`, method, path, options);
  }
}

/** The connection failed before a response arrived (DNS, reset, TLS). Same retry rule as a timeout. */
export class PayPalNetworkError extends PayPalError {
  override readonly name = "PayPalNetworkError";
  readonly outcomeUnknown = true;

  constructor(method: HttpMethod, path: string, options?: { cause?: unknown }) {
    const reason = options?.cause instanceof Error ? options.cause.message : "network failure";
    super(`${method} ${path} failed before a response: ${reason}`, method, path, options);
  }
}

/** A 2xx body we cannot interpret. Fail closed: treat like an unknown outcome and re-read the resource. */
export class PayPalResponseError extends PayPalError {
  override readonly name = "PayPalResponseError";

  constructor(
    method: HttpMethod,
    path: string,
    readonly status: number,
    readonly debugId: string | null,
    readonly problems: readonly string[],
  ) {
    super(
      `${method} ${path} -> ${status}: unexpected response shape (${problems.join("; ")}) (PayPal-Debug-Id ${debugId ?? "none"})`,
      method,
      path,
    );
  }
}

/** A PayPal call succeeded but the resource is not in a state the flow can continue from. */
export class PayPalFlowError extends Error {
  override readonly name = "PayPalFlowError";

  constructor(
    message: string,
    readonly resourceId: string | null,
    readonly status: string | null,
    readonly debugId: string | null,
  ) {
    super(`${message} (PayPal-Debug-Id ${debugId ?? "none"})`);
  }
}

// PayPal REST errors use {name, message, debug_id, details[]}; identity (OAuth) errors use
// {error, error_description}. Both shapes are accepted; everything else is optional.
const ErrorBodySchema = z.looseObject({
  name: z.string().optional(),
  message: z.string().optional(),
  debug_id: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
  details: z
    .array(
      z.looseObject({
        issue: z.string().optional(),
        field: z.string().optional(),
        value: z.unknown().optional(),
        location: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
});

const MAX_TEXT = 300;

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/** Builds a PayPalApiError from a non-2xx response body (parsed JSON, raw text, or nothing). */
export function toApiError(init: {
  method: HttpMethod;
  path: string;
  status: number;
  headerDebugId: string | null;
  body: unknown;
  rawText: string;
}): PayPalApiError {
  const parsed = ErrorBodySchema.safeParse(init.body);
  const body = parsed.success ? parsed.data : undefined;
  const details: PayPalErrorDetail[] = (body?.details ?? []).map((d) => ({
    issue: d.issue,
    field: d.field,
    value: d.value === undefined ? undefined : clip(typeof d.value === "string" ? d.value : JSON.stringify(d.value)),
    location: d.location,
    description: d.description,
  }));
  const fallbackText = init.rawText.trim() === "" ? "no response body" : clip(init.rawText.trim());
  return new PayPalApiError({
    method: init.method,
    path: init.path,
    status: init.status,
    name: body?.name ?? body?.error ?? `HTTP_${init.status}`,
    paypalMessage: body?.message ?? body?.error_description ?? fallbackText,
    details,
    debugId: init.headerDebugId ?? body?.debug_id ?? null,
  });
}
