// Client-credentials OAuth (POST /v1/oauth2/token) with an in-memory cache refreshed at
// expires_in - 120 s and single-flight refresh (plan §6.8): concurrent callers share one request,
// so a burst of agent checkouts never stampedes the token endpoint.
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertSandbox, type PayPalConfig } from "./config";
import { PayPalResponseError, toApiError } from "./errors";
import { consoleLogger, DEFAULT_TIMEOUT_MS, send, type FetchLike, type PayPalLogger } from "./transport";

export const TOKEN_PATH = "/v1/oauth2/token";
export const TOKEN_REFRESH_MARGIN_SECONDS = 120;

const TokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().int().positive(),
  app_id: z.string().optional(),
  scope: z.string().optional(),
});

export interface TokenProviderOptions {
  readonly config: PayPalConfig;
  readonly fetch?: FetchLike;
  /** Milliseconds since the epoch; injectable so tests can move time. */
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly logger?: PayPalLogger;
}

interface CachedToken {
  readonly token: string;
  /** Epoch ms after which the token is treated as stale and refreshed. */
  readonly refreshAt: number;
}

export class PayPalTokenProvider {
  readonly #config: PayPalConfig;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #logger: PayPalLogger;
  #cached: CachedToken | null = null;
  #inflight: Promise<string> | null = null;

  constructor(options: TokenProviderOptions) {
    assertSandbox(options.config);
    this.#config = options.config;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#logger = options.logger ?? consoleLogger;
  }

  /** Returns a valid bearer token, fetching one only when the cache is empty or stale. */
  getAccessToken(): Promise<string> {
    const cached = this.#cached;
    if (cached !== null && this.#now() < cached.refreshAt) return Promise.resolve(cached.token);
    if (this.#inflight !== null) return this.#inflight;
    const inflight = this.#fetchToken().finally(() => {
      if (this.#inflight === inflight) this.#inflight = null;
    });
    this.#inflight = inflight;
    return inflight;
  }

  /**
   * Drops the cached token after PayPal rejected it with 401. Passing the rejected token avoids
   * discarding a newer token that another caller already fetched.
   */
  invalidate(rejectedToken?: string): void {
    if (rejectedToken === undefined || this.#cached?.token === rejectedToken) this.#cached = null;
  }

  async #fetchToken(): Promise<string> {
    const requestedAt = this.#now();
    // §22 rule 12 covers every PayPal POST. A token request is not a resource to replay, so each fetch
    // gets a fresh id: a retried fetch must never be handed a stored (possibly expired) token.
    const requestId = `oauth:${randomUUID()}`;
    const basic = Buffer.from(`${this.#config.clientId}:${this.#config.clientSecret}`, "utf8").toString("base64");
    const response = await send({
      fetch: this.#fetch,
      baseUrl: this.#config.baseUrl,
      method: "POST",
      path: TOKEN_PATH,
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "PayPal-Request-Id": requestId,
      },
      body: "grant_type=client_credentials",
      timeoutMs: this.#timeoutMs,
      logger: this.#logger,
      requestId,
      now: this.#now,
    });
    if (response.status < 200 || response.status >= 300) {
      throw toApiError({
        method: "POST",
        path: TOKEN_PATH,
        status: response.status,
        headerDebugId: response.debugId,
        body: response.json,
        rawText: response.rawText,
      });
    }
    const parsed = TokenResponseSchema.safeParse(response.json);
    if (!parsed.success) {
      // Report only field paths: the body holds the token itself.
      const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.code}`);
      throw new PayPalResponseError("POST", TOKEN_PATH, response.status, response.debugId, problems);
    }
    if (parsed.data.token_type.toLowerCase() !== "bearer") {
      throw new PayPalResponseError("POST", TOKEN_PATH, response.status, response.debugId, [
        `token_type is ${JSON.stringify(parsed.data.token_type)}, expected Bearer`,
      ]);
    }
    const lifetimeSeconds = Math.max(0, parsed.data.expires_in - TOKEN_REFRESH_MARGIN_SECONDS);
    this.#cached = { token: parsed.data.access_token, refreshAt: requestedAt + lifetimeSeconds * 1000 };
    return parsed.data.access_token;
  }
}
