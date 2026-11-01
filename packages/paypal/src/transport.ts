// One place that performs a PayPal HTTP exchange: timeout, network-failure mapping, body parsing and
// the PayPal-Debug-Id log line every response must produce. Used by both OAuth and the API client.
import { PayPalNetworkError, PayPalTimeoutError, type HttpMethod } from "./errors";

/** The subset of `fetch` we use; injectable so unit tests never reach the network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface PayPalLogEntry {
  readonly method: HttpMethod;
  readonly path: string;
  /** null when no response arrived (timeout or network failure). */
  readonly status: number | null;
  readonly debugId: string | null;
  readonly requestId: string | null;
  readonly durationMs: number;
  readonly outcome: "ok" | "error" | "timeout" | "network";
}

/** Receives one entry per PayPal exchange. Entries never contain headers, bodies or tokens. */
export type PayPalLogger = (entry: PayPalLogEntry) => void;

export const consoleLogger: PayPalLogger = (entry) => {
  const status = entry.status === null ? entry.outcome.toUpperCase() : String(entry.status);
  const requestId = entry.requestId === null ? "" : ` request_id=${entry.requestId}`;
  console.info(`[paypal] ${entry.method} ${entry.path} -> ${status} debug_id=${entry.debugId ?? "none"}${requestId} ${entry.durationMs}ms`);
};

/** Plan §6.8: PayPal calls time out after 15 s; the saga treats a timeout as "outcome unknown". */
export const DEFAULT_TIMEOUT_MS = 15_000;

export const DEBUG_ID_HEADER = "paypal-debug-id";

export interface RawResponse {
  readonly status: number;
  readonly debugId: string | null;
  /** Parsed JSON, or null for an empty body, or undefined when the body was not valid JSON. */
  readonly json: unknown;
  readonly rawText: string;
}

export interface SendInit {
  readonly fetch: FetchLike;
  readonly baseUrl: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly query?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly logger: PayPalLogger;
  readonly requestId: string | null;
  readonly now: () => number;
}

function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "TimeoutError";
}

export async function send(init: SendInit): Promise<RawResponse> {
  const started = init.now();
  const signal = AbortSignal.timeout(init.timeoutMs);
  const log = (status: number | null, debugId: string | null, outcome: PayPalLogEntry["outcome"]): void => {
    init.logger({
      method: init.method,
      path: init.path,
      status,
      debugId,
      requestId: init.requestId,
      durationMs: Math.max(0, init.now() - started),
      outcome,
    });
  };
  const fail = (error: unknown): never => {
    if (isTimeout(error) || signal.aborted) {
      log(null, null, "timeout");
      throw new PayPalTimeoutError(init.method, init.path, init.timeoutMs, { cause: error });
    }
    log(null, null, "network");
    throw new PayPalNetworkError(init.method, init.path, { cause: error });
  };

  let response: Response;
  let rawText: string;
  try {
    // redirect "error": a PayPal API never redirects, and following one could carry the bearer token elsewhere.
    response = await init.fetch(`${init.baseUrl}${init.path}${init.query ?? ""}`, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal,
      redirect: "error",
    });
    rawText = await response.text();
  } catch (error) {
    return fail(error);
  }

  const debugId = response.headers.get(DEBUG_ID_HEADER);
  let json: unknown = null;
  if (rawText.trim() !== "") {
    try {
      json = JSON.parse(rawText) as unknown;
    } catch {
      json = undefined;
    }
  }
  log(response.status, debugId, response.ok ? "ok" : "error");
  return { status: response.status, debugId, json, rawText };
}
