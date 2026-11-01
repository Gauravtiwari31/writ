import { describe, expect, it } from "vitest";
import { PayPalTokenProvider } from "../src/auth";
import {
  assertSandbox,
  loadPayPalConfig,
  makePayPalConfig,
  PAYPAL_SANDBOX_BASE_URL,
  PayPalConfigError,
  type PayPalConfig,
} from "../src/config";
import { createPayPalHttp, PayPalHttp } from "../src/http";
import { CLIENT_SECRET } from "./fake";

const GOOD_ENV = { PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_ID: "cid", PAYPAL_CLIENT_SECRET: CLIENT_SECRET };

describe("loadPayPalConfig (sandbox-only guard, §22 rule 21)", () => {
  it("loads a sandbox config with the fixed sandbox base URL", () => {
    const config = loadPayPalConfig(GOOD_ENV);
    expect(config.env).toBe("sandbox");
    expect(config.baseUrl).toBe("https://api-m.sandbox.paypal.com");
    expect(config.clientId).toBe("cid");
    expect(config.clientSecret).toBe(CLIENT_SECRET);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["live", "live"],
    ["production", "production"],
    ["wrong case", "Sandbox"],
  ])("refuses PAYPAL_ENV %s", (_label, value) => {
    const env = { ...GOOD_ENV, PAYPAL_ENV: value };
    expect(() => loadPayPalConfig(env)).toThrow(PayPalConfigError);
    expect(() => loadPayPalConfig(env)).toThrow(/PAYPAL_ENV must be "sandbox"/);
  });

  it("names every missing credential and never echoes the secret", () => {
    expect(() => loadPayPalConfig({ PAYPAL_ENV: "sandbox" })).toThrow(/PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
    expect(() => loadPayPalConfig({ PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_SECRET: CLIENT_SECRET })).toThrow(/Missing PAYPAL_CLIENT_ID\./);
    try {
      loadPayPalConfig({ PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_SECRET: CLIENT_SECRET });
    } catch (error) {
      expect(String(error)).not.toContain(CLIENT_SECRET);
    }
  });

  it("treats whitespace-only credentials as missing", () => {
    expect(() => loadPayPalConfig({ ...GOOD_ENV, PAYPAL_CLIENT_ID: "   " })).toThrow(/Missing PAYPAL_CLIENT_ID/);
  });

  it("keeps the secret out of JSON and key listings", () => {
    const config = loadPayPalConfig(GOOD_ENV);
    expect(JSON.stringify(config)).not.toContain(CLIENT_SECRET);
    expect(Object.keys(config)).not.toContain("clientSecret");
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("refuses a hand-built config that points anywhere but the sandbox", () => {
    const forged = { env: "sandbox", baseUrl: "https://api-m.paypal.com", clientId: "cid", clientSecret: "x" } as unknown as PayPalConfig;
    expect(() => assertSandbox(forged)).toThrow(/sandbox only/);
    expect(() => new PayPalHttp({ config: forged })).toThrow(PayPalConfigError);
    expect(() => new PayPalTokenProvider({ config: forged })).toThrow(PayPalConfigError);
    const liveEnv = { ...makePayPalConfig("cid", "x"), env: "live" } as unknown as PayPalConfig;
    expect(() => assertSandbox(liveEnv)).toThrow(PayPalConfigError);
  });

  it("createPayPalHttp applies the same guard", () => {
    expect(() => createPayPalHttp({ ...GOOD_ENV, PAYPAL_ENV: "live" })).toThrow(PayPalConfigError);
    expect(createPayPalHttp(GOOD_ENV).config.baseUrl).toBe(PAYPAL_SANDBOX_BASE_URL);
  });
});
