// Typed client for the public agent API (plan §6.6, P0-3). Used by the built-in agents, the local
// smoke script (an external agent over HTTP) and WritBench. Every response is parsed with the
// @writ/core/api schema, so contract drift fails loudly. A policy BLOCK at checkout is an answer
// (HTTP 403 with a CheckoutResponse), not an exception.
import type { CatalogItem } from "@writ/core";
import {
  AgentProductResponseSchema,
  AgentPurchaseViewSchema,
  AgentSearchResponseSchema,
  AgentWritListResponseSchema,
  AgentWritViewSchema,
  ApiErrorSchema,
  CheckoutResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKeySchema,
  ProposeCartResponseSchema,
  type AgentPurchaseView,
  type AgentSearchRequest,
  type AgentSearchResponse,
  type AgentWritListResponse,
  type AgentWritView,
  type CheckoutRequest,
  type CheckoutResponse,
  type ProposeCartRequest,
  type ProposeCartResponse,
} from "@writ/core/api";
import type { z } from "zod";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AgentApiClientOptions {
  /** Gateway origin, e.g. http://127.0.0.1:10000 (built-in agents) or https://writ-gateway.onrender.com. */
  baseUrl: string;
  /** "wak_..." agent key. */
  apiKey: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class AgentApiError extends Error {
  override readonly name = "AgentApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class AgentApiClient {
  readonly #base: string;
  readonly #key: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: AgentApiClientOptions) {
    this.#base = new URL(options.baseUrl).origin;
    this.#key = options.apiKey;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  listWrits(): Promise<AgentWritListResponse> {
    return this.#call("GET", "/v1/agent/writs", undefined, AgentWritListResponseSchema);
  }

  getWrit(writId: string): Promise<AgentWritView> {
    return this.#call("GET", `/v1/agent/writs/${encodeURIComponent(writId)}`, undefined, AgentWritViewSchema);
  }

  search(request: AgentSearchRequest): Promise<AgentSearchResponse> {
    return this.#call("POST", "/v1/agent/search", request, AgentSearchResponseSchema);
  }

  async getProduct(productRef: string): Promise<CatalogItem> {
    const body = await this.#call("GET", `/v1/agent/products/${encodeURIComponent(productRef)}`, undefined, AgentProductResponseSchema);
    return body.product;
  }

  proposeCart(request: ProposeCartRequest): Promise<ProposeCartResponse> {
    return this.#call("POST", "/v1/agent/carts", request, ProposeCartResponseSchema);
  }

  /** 200/202 and the 403 policy BLOCK all resolve with the typed outcome (`httpStatus` tells them apart). */
  async checkout(request: CheckoutRequest, idempotencyKey: string): Promise<{ httpStatus: number; result: CheckoutResponse }> {
    IdempotencyKeySchema.parse(idempotencyKey);
    const response = await this.#send("POST", "/v1/agent/checkout", request, { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey });
    const json = await readJson(response);
    if (response.ok || response.status === 403) {
      const parsed = CheckoutResponseSchema.safeParse(json);
      if (parsed.success) return { httpStatus: response.status, result: parsed.data };
      if (response.ok) throw new AgentApiError(response.status, "invalid_response", "checkout response does not match CheckoutResponseSchema");
    }
    throw toApiError(response.status, json);
  }

  getPurchase(purchaseId: string): Promise<AgentPurchaseView> {
    return this.#call("GET", `/v1/agent/purchases/${encodeURIComponent(purchaseId)}`, undefined, AgentPurchaseViewSchema);
  }

  async #call<S extends z.ZodType>(method: "GET" | "POST", path: string, body: unknown, schema: S): Promise<z.output<S>> {
    const response = await this.#send(method, path, body, {});
    const json = await readJson(response);
    if (!response.ok) throw toApiError(response.status, json);
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new AgentApiError(response.status, "invalid_response", `${method} ${path}: response does not match the contract`);
    return parsed.data;
  }

  #send(method: "GET" | "POST", path: string, body: unknown, extra: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#key}`, accept: "application/json", ...extra };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.#timeoutMs) };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return this.#fetch(`${this.#base}${path}`, init);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 200);
  }
}

function toApiError(status: number, json: unknown): AgentApiError {
  const parsed = ApiErrorSchema.safeParse(json);
  return parsed.success
    ? new AgentApiError(status, parsed.data.error, parsed.data.message)
    : new AgentApiError(status, "http_error", `gateway answered HTTP ${status}`);
}
