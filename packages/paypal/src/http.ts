// Authenticated JSON client for the PayPal REST API. Every response is logged with its
// PayPal-Debug-Id (transport), every POST carries a PayPal-Request-Id (§22 rule 12, enforced by the
// type), and every 2xx body is validated against a lenient schema before anyone reads it.
import type { z } from "zod";
import { PayPalTokenProvider } from "./auth";
import { assertSandbox, loadPayPalConfig, type EnvSource, type PayPalConfig } from "./config";
import { PayPalResponseError, toApiError, type HttpMethod } from "./errors";
import { consoleLogger, DEFAULT_TIMEOUT_MS, send, type FetchLike, type PayPalLogger, type RawResponse } from "./transport";

/** Orders v2 caps PayPal-Request-Id at 108 chars, the tightest limit of the APIs we call. */
export const MAX_REQUEST_ID_LENGTH = 108;

export type PreferHeader = "return=representation" | "return=minimal";

export interface PayPalResponse<T> {
  readonly status: number;
  readonly data: T;
  readonly debugId: string | null;
}

export interface PostOptions {
  /** Idempotency key. PayPal replays the stored result when it sees the same id again. */
  readonly requestId: string;
  readonly prefer?: PreferHeader;
}

export interface GetOptions {
  readonly query?: Readonly<Record<string, string>>;
}

/** What PayPalHttp needs from the token cache; PayPalTokenProvider implements it. */
export interface AccessTokenSource {
  getAccessToken(): Promise<string>;
  invalidate(rejectedToken?: string): void;
}

export interface PayPalHttpOptions {
  readonly config: PayPalConfig;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly logger?: PayPalLogger;
  /** Defaults to a PayPalTokenProvider sharing this client's fetch, clock, timeout and logger. */
  readonly tokens?: AccessTokenSource;
}

/**
 * The purchase steps that call PayPal. `authorize` is the create-order call (plan §7 header
 * example); `order-authorize` is the follow-up POST /v2/checkout/orders/{id}/authorize.
 */
export type PurchaseStep = "authorize" | "order-authorize" | "capture" | "void" | "refund";

/** Plan §6.8: PayPal-Request-Id = "<purchase_id>:<step>", so a retried saga step replays, never repeats. */
export function purchaseRequestId(purchaseId: string, step: PurchaseStep): string {
  if (purchaseId.trim() === "") throw new TypeError("purchaseId must be non-empty");
  return checkRequestId(`${purchaseId}:${step}`);
}

function checkRequestId(requestId: string): string {
  if (requestId.trim() === "") throw new TypeError("PayPal-Request-Id must be non-empty");
  if (requestId.length > MAX_REQUEST_ID_LENGTH) {
    throw new TypeError(`PayPal-Request-Id must be at most ${MAX_REQUEST_ID_LENGTH} chars (got ${requestId.length})`);
  }
  return requestId;
}

/** Encodes one path segment (an id returned by PayPal or chosen by us). */
export function seg(id: string): string {
  if (id === "") throw new TypeError("PayPal resource id must be non-empty");
  return encodeURIComponent(id);
}

interface CallInit {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly requestId: string | null;
  readonly prefer?: PreferHeader;
}

export class PayPalHttp {
  readonly config: PayPalConfig;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #logger: PayPalLogger;
  readonly #tokens: AccessTokenSource;

  constructor(options: PayPalHttpOptions) {
    assertSandbox(options.config);
    this.config = options.config;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#logger = options.logger ?? consoleLogger;
    this.#tokens =
      options.tokens ??
      new PayPalTokenProvider({
        config: options.config,
        fetch: this.#fetch,
        now: this.#now,
        timeoutMs: this.#timeoutMs,
        logger: this.#logger,
      });
  }

  get<S extends z.ZodType>(path: string, schema: S, options: GetOptions = {}): Promise<PayPalResponse<z.output<S>>> {
    return this.#request({ method: "GET", path, requestId: null, ...(options.query ? { query: options.query } : {}) }, schema);
  }

  post<S extends z.ZodType>(path: string, body: unknown, schema: S, options: PostOptions): Promise<PayPalResponse<z.output<S>>> {
    const requestId = checkRequestId(options.requestId);
    return this.#request({ method: "POST", path, body, requestId, ...(options.prefer ? { prefer: options.prefer } : {}) }, schema);
  }

  delete<S extends z.ZodType>(path: string, schema: S): Promise<PayPalResponse<z.output<S>>> {
    return this.#request({ method: "DELETE", path, requestId: null }, schema);
  }

  async #request<S extends z.ZodType>(init: CallInit, schema: S): Promise<PayPalResponse<z.output<S>>> {
    let token = await this.#tokens.getAccessToken();
    let raw = await this.#send(init, token);
    if (raw.status === 401) {
      // A cached token can be revoked before its expiry; fetch a fresh one and retry once with the
      // same PayPal-Request-Id, which keeps a POST idempotent.
      this.#tokens.invalidate(token);
      token = await this.#tokens.getAccessToken();
      raw = await this.#send(init, token);
    }
    if (raw.status < 200 || raw.status >= 300) {
      throw toApiError({
        method: init.method,
        path: init.path,
        status: raw.status,
        headerDebugId: raw.debugId,
        body: raw.json,
        rawText: raw.rawText,
      });
    }
    if (raw.json === undefined) {
      throw new PayPalResponseError(init.method, init.path, raw.status, raw.debugId, ["body is not valid JSON"]);
    }
    const parsed = schema.safeParse(raw.json);
    if (!parsed.success) {
      // Paths and codes only: a body can hold payer details we do not want in logs.
      const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.code}`);
      throw new PayPalResponseError(init.method, init.path, raw.status, raw.debugId, problems);
    }
    return { status: raw.status, data: parsed.data, debugId: raw.debugId };
  }

  #send(init: CallInit, token: string): Promise<RawResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.requestId !== null) headers["PayPal-Request-Id"] = init.requestId;
    if (init.prefer !== undefined) headers.Prefer = init.prefer;
    const query = init.query === undefined ? "" : `?${new URLSearchParams(init.query).toString()}`;
    return send({
      fetch: this.#fetch,
      baseUrl: this.config.baseUrl,
      method: init.method,
      path: init.path,
      query,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      timeoutMs: this.#timeoutMs,
      logger: this.#logger,
      requestId: init.requestId,
      now: this.#now,
    });
  }
}

/** Loads the sandbox-only config from the environment (throws PayPalConfigError) and builds a client. */
export function createPayPalHttp(env: EnvSource = process.env, options: Omit<PayPalHttpOptions, "config"> = {}): PayPalHttp {
  return new PayPalHttp({ ...options, config: loadPayPalConfig(env) });
}
