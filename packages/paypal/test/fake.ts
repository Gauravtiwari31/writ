// Test doubles for PayPal over HTTP. Unit tests only (§22 rule 41): nothing here reaches the network.
import { makePayPalConfig, type PayPalConfig } from "../src/config";
import { PayPalHttp } from "../src/http";
import type { FetchLike, PayPalLogEntry } from "../src/transport";

export const CLIENT_ID = "test-client-id";
export const CLIENT_SECRET = "test-client-secret-DO-NOT-LOG";
export const ACCESS_TOKEN = "A21AAtest-access-token";

export function testConfig(): PayPalConfig {
  return makePayPalConfig(CLIENT_ID, CLIENT_SECRET);
}

export interface RecordedCall {
  readonly url: string;
  readonly path: string;
  readonly search: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

export type Handler = (call: RecordedCall, init: RequestInit) => Response | Promise<Response>;

export function jsonResponse(status: number, body: unknown, debugId: string | null = "dbg-test"): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (debugId !== null) headers["paypal-debug-id"] = debugId;
  if (body === undefined || status === 204) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), { status, headers });
}

export function tokenResponse(token = ACCESS_TOKEN, expiresIn = 32_400): Response {
  return jsonResponse(200, { scope: "https://uri.paypal.com/services/payments", access_token: token, token_type: "Bearer", app_id: "APP-80W284485P519543T", expires_in: expiresIn, nonce: "n" }, "dbg-token");
}

export interface FakeFetch {
  readonly fetch: FetchLike;
  readonly calls: RecordedCall[];
  /** Calls other than the OAuth token request. */
  apiCalls(): RecordedCall[];
}

/** Records every call; the token endpoint answers automatically unless `handler` handles it. */
export function fakeFetch(handler: Handler, options: { autoToken?: boolean } = {}): FakeFetch {
  const calls: RecordedCall[] = [];
  const autoToken = options.autoToken ?? true;
  const fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: RecordedCall = {
      url,
      path: parsed.pathname,
      search: parsed.search,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    if (autoToken && call.path === "/v1/oauth2/token") return tokenResponse();
    return handler(call, init);
  };
  return { fetch, calls, apiCalls: () => calls.filter((c) => c.path !== "/v1/oauth2/token") };
}

export function makeHttp(handler: Handler, options: { timeoutMs?: number; autoToken?: boolean } = {}) {
  const fake = fakeFetch(handler, options.autoToken === undefined ? {} : { autoToken: options.autoToken });
  const logs: PayPalLogEntry[] = [];
  const http = new PayPalHttp({
    config: testConfig(),
    fetch: fake.fetch,
    logger: (entry) => logs.push(entry),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { http, logs, ...fake };
}

export function bodyOf(call: RecordedCall | undefined): unknown {
  if (call?.body === undefined) return undefined;
  return JSON.parse(call.body) as unknown;
}
