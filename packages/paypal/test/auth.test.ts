import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { PayPalTokenProvider, TOKEN_REFRESH_MARGIN_SECONDS } from "../src/auth";
import { PayPalApiError, PayPalResponseError } from "../src/errors";
import type { PayPalLogEntry } from "../src/transport";
import { ACCESS_TOKEN, CLIENT_ID, CLIENT_SECRET, fakeFetch, jsonResponse, testConfig, tokenResponse } from "./fake";

function setup(respond: (n: number) => Response | Promise<Response>) {
  let clock = 1_000_000;
  let n = 0;
  const logs: PayPalLogEntry[] = [];
  const fake = fakeFetch(() => respond(++n), { autoToken: false });
  const provider = new PayPalTokenProvider({
    config: testConfig(),
    fetch: fake.fetch,
    now: () => clock,
    logger: (entry) => logs.push(entry),
  });
  return {
    provider,
    fake,
    logs,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("PayPalTokenProvider", () => {
  it("requests a client-credentials token with HTTP Basic auth", async () => {
    const { provider, fake } = setup(() => tokenResponse());
    await expect(provider.getAccessToken()).resolves.toBe(ACCESS_TOKEN);
    const call = fake.calls[0];
    expect(call?.url).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(call?.method).toBe("POST");
    expect(call?.body).toBe("grant_type=client_credentials");
    expect(call?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call?.headers.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    // §22 rule 12: every PayPal POST carries a PayPal-Request-Id; a token fetch gets a fresh one.
    expect(call?.headers["paypal-request-id"]).toMatch(/^oauth:[0-9a-f-]{36}$/);
  });

  it("uses a new PayPal-Request-Id for every token fetch, so no stored token is replayed", async () => {
    const { provider, fake, advance } = setup(() => tokenResponse(ACCESS_TOKEN, 200));
    await provider.getAccessToken();
    advance(200_000);
    await provider.getAccessToken();
    const ids = fake.calls.map((c) => c.headers["paypal-request-id"]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("caches the token and refreshes it at expires_in - 120 s", async () => {
    const { provider, fake, advance } = setup((n) => tokenResponse(`token-${n}`, 3600));
    expect(await provider.getAccessToken()).toBe("token-1");
    advance((3600 - TOKEN_REFRESH_MARGIN_SECONDS) * 1000 - 1);
    expect(await provider.getAccessToken()).toBe("token-1");
    expect(fake.calls).toHaveLength(1);
    advance(1);
    expect(await provider.getAccessToken()).toBe("token-2");
    expect(fake.calls).toHaveLength(2);
  });

  it("never caches a token that lives shorter than the refresh margin", async () => {
    const { provider, fake } = setup((n) => tokenResponse(`token-${n}`, 60));
    expect(await provider.getAccessToken()).toBe("token-1");
    expect(await provider.getAccessToken()).toBe("token-2");
    expect(fake.calls).toHaveLength(2);
  });

  it("shares one in-flight request between concurrent callers (single-flight)", async () => {
    let release: (response: Response) => void = () => undefined;
    const { provider, fake } = setup(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const pending = Array.from({ length: 10 }, () => provider.getAccessToken());
    await Promise.resolve();
    expect(fake.calls).toHaveLength(1);
    release(tokenResponse());
    const tokens = await Promise.all(pending);
    expect(new Set(tokens)).toEqual(new Set([ACCESS_TOKEN]));
    expect(fake.calls).toHaveLength(1);
  });

  it("surfaces an OAuth failure with its debug id, then retries on the next call", async () => {
    const { provider, fake } = setup((n) =>
      n === 1 ? jsonResponse(401, { error: "invalid_client", error_description: "Client Authentication failed" }, "dbg-oauth") : tokenResponse(),
    );
    const error = await provider.getAccessToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalApiError);
    const apiError = error as PayPalApiError;
    expect(apiError.status).toBe(401);
    expect(apiError.name).toBe("invalid_client");
    expect(apiError.paypalMessage).toBe("Client Authentication failed");
    expect(apiError.debugId).toBe("dbg-oauth");
    expect(apiError.path).toBe("/v1/oauth2/token");
    expect(apiError.message).not.toContain(CLIENT_SECRET);
    await expect(provider.getAccessToken()).resolves.toBe(ACCESS_TOKEN);
    expect(fake.calls).toHaveLength(2);
  });

  it("rejects a token response without access_token and never echoes the body", async () => {
    const { provider } = setup(() => jsonResponse(200, { token_type: "Bearer", expires_in: 3600, leaked: "secret-ish" }));
    const error = await provider.getAccessToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalResponseError);
    expect(String((error as Error).message)).toContain("access_token");
    expect(String((error as Error).message)).not.toContain("secret-ish");
  });

  it("rejects a non-Bearer token type", async () => {
    const { provider } = setup(() => jsonResponse(200, { access_token: "t", token_type: "MAC", expires_in: 3600 }));
    await expect(provider.getAccessToken()).rejects.toThrow(/expected Bearer/);
  });

  it("invalidate() drops only the rejected token", async () => {
    const { provider, fake } = setup((n) => tokenResponse(`token-${n}`));
    await provider.getAccessToken();
    provider.invalidate("some-other-token");
    expect(await provider.getAccessToken()).toBe("token-1");
    provider.invalidate("token-1");
    expect(await provider.getAccessToken()).toBe("token-2");
    expect(fake.calls).toHaveLength(2);
  });

  it("logs the debug id of the token call but never the token", async () => {
    const { provider, logs } = setup(() => tokenResponse());
    await provider.getAccessToken();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ method: "POST", path: "/v1/oauth2/token", status: 200, debugId: "dbg-token", outcome: "ok" });
    expect(JSON.stringify(logs)).not.toContain(ACCESS_TOKEN);
  });
});
