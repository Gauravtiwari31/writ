// Spike S6 plugin tests. A tiny software authenticator (P-256, "none" attestation) drives the full
// register -> sign -> tamper flow so the server logic is checked without a browser.
import { createHash, generateKeyPairSync, sign as signDer, type KeyObject } from "node:crypto";
import { fromBase64Url, hashJcs, jcs, toBase64Url } from "@writ/core";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReport,
  describeClient,
  isLoopbackHost,
  PASSKEY_SPIKE_PREFIX,
  passkeySpikePlugin,
  resolvePasskeySpikeConfig,
  SAMPLE_WRIT,
  spikesEnabled,
  tamperWrit,
  type PasskeySpikeEvent,
  type PasskeySpikeOptions,
  type SpikeWrit,
} from "../src/spikes/passkey";
import { PASSKEY_PAGE_CSP, SIMPLEWEBAUTHN_BROWSER_CDN } from "../src/spikes/passkey-page";

const BASE = PASSKEY_SPIKE_PREFIX;
const WINDOWS_HELLO_AAGUID = "08987058-cadc-4b81-b6e1-30de50dcbe96";
const DESKTOP_CHROME = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};
const ANDROID_CHROME = {
  "user-agent": "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  "sec-ch-ua-mobile": "?1",
  "sec-ch-ua-platform": '"Android"',
};

// ---- minimal CBOR encoder (only what attestationObject and a COSE EC2 key need) ----

class CborMap {
  constructor(readonly entries: ReadonlyArray<readonly [CborValue, CborValue]>) {}
}
type CborValue = number | string | Uint8Array | CborMap;

function cborHead(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function cbor(value: CborValue): number[] {
  if (typeof value === "number") return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return [...cborHead(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array) return [...cborHead(2, value.length), ...value];
  return [...cborHead(5, value.entries.length), ...value.entries.flatMap(([k, v]) => [...cbor(k), ...cbor(v)])];
}

// ---- software authenticator ----

function sha256(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function uuidBytes(uuid: string): Uint8Array {
  return Uint8Array.from(Buffer.from(uuid.replace(/-/g, ""), "hex"));
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

interface SoftAuthenticator {
  credentialId: string;
  privateKey: KeyObject;
  counter: number;
  attachment: "platform" | "cross-platform";
  transports: string[];
}

function newAuthenticator(attachment: "platform" | "cross-platform", transports: string[]): SoftAuthenticator & { coseKey: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") throw new Error("EC JWK without coordinates");
  const coseKey = Uint8Array.from(
    cbor(
      new CborMap([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, fromBase64Url(jwk.x)],
        [-3, fromBase64Url(jwk.y)],
      ]),
    ),
  );
  const credentialId = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { credentialId, privateKey, counter: 0, attachment, transports, coseKey };
}

function clientData(type: string, challenge: string, origin: string): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false })));
}

function attestation(auth: SoftAuthenticator & { coseKey: Uint8Array }, rpID: string, challenge: string, origin: string) {
  const credId = fromBase64Url(auth.credentialId);
  const authData = Uint8Array.from([
    ...sha256(rpID),
    FLAG_UP | FLAG_UV | FLAG_AT,
    ...u32(0),
    ...uuidBytes(WINDOWS_HELLO_AAGUID),
    credId.length >> 8,
    credId.length & 0xff,
    ...credId,
    ...auth.coseKey,
  ]);
  const attestationObject = Uint8Array.from(
    cbor(
      new CborMap([
        ["fmt", "none"],
        ["attStmt", new CborMap([])],
        ["authData", authData],
      ]),
    ),
  );
  return {
    id: auth.credentialId,
    rawId: auth.credentialId,
    type: "public-key",
    response: {
      clientDataJSON: clientData("webauthn.create", challenge, origin),
      attestationObject: toBase64Url(attestationObject),
      transports: auth.transports,
    },
    authenticatorAttachment: auth.attachment,
    clientExtensionResults: {},
  };
}

function assertion(auth: SoftAuthenticator, rpID: string, challenge: string, origin: string, flags = FLAG_UP | FLAG_UV) {
  auth.counter += 1;
  const authData = Uint8Array.from([...sha256(rpID), flags, ...u32(auth.counter)]);
  const clientDataJSON = clientData("webauthn.get", challenge, origin);
  const signed = Buffer.concat([authData, sha256(fromBase64Url(clientDataJSON))]);
  const signature = new Uint8Array(signDer("sha256", signed, auth.privateKey));
  return {
    id: auth.credentialId,
    rawId: auth.credentialId,
    type: "public-key",
    response: {
      clientDataJSON,
      authenticatorData: toBase64Url(authData),
      signature: toBase64Url(signature),
    },
    authenticatorAttachment: auth.attachment,
    clientExtensionResults: {},
  };
}

// ---- helpers ----

const apps: FastifyInstance[] = [];

async function makeApp(options: PasskeySpikeOptions = { rpID: "localhost", origins: [] }): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(passkeySpikePlugin, options);
  await app.ready();
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function post(app: FastifyInstance, path: string, payload: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: "POST", url: `${BASE}${path}`, payload: payload as object, headers });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function register(app: FastifyInstance, auth: SoftAuthenticator & { coseKey: Uint8Array }, rpID: string, origin: string, headers = DESKTOP_CHROME) {
  const opts = await post(app, "/register/options", { authenticator: auth.attachment === "platform" ? "platform" : "phone" });
  expect(opts.status).toBe(200);
  const reg = await post(app, "/register/verify", { response: attestation(auth, rpID, String(opts.body.challenge), origin) }, headers);
  expect(reg.status, JSON.stringify(reg.body)).toBe(200);
  return reg.body;
}

async function signOnce(app: FastifyInstance, auth: SoftAuthenticator, rpID: string, origin: string, headers: Record<string, string>) {
  const opts = await post(app, "/sign/options", { via: "any" });
  expect(opts.status).toBe(200);
  const response = assertion(auth, rpID, String(opts.body.challenge), origin);
  const verify = await post(app, "/sign/verify", { response }, headers);
  return { opts: opts.body, response, verify };
}

// ---- tests ----

describe("spike S6 page", () => {
  it("serves a noindex page with the pinned, SRI-protected browser bundle and a strict CSP", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: BASE });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(res.headers["content-security-policy"]).toBe(PASSKEY_PAGE_CSP);
    expect(res.body).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(res.body).toContain(`src="${SIMPLEWEBAUTHN_BROWSER_CDN.url}" integrity="${SIMPLEWEBAUTHN_BROWSER_CDN.integrity}"`);
    expect(res.body).toContain("Spike S6");
    // The page config carries the base path and the loopback origin it will be verified against.
    expect(res.body).toContain(`"basePath":"${BASE}"`);
    expect(res.body).toContain('"expectedOrigins":["http://localhost"]');
  });

  it("marks API responses noindex too", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `${BASE}/report` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
  });
});

describe("spike S6 options", () => {
  it("sign/options uses exactly the 32 bytes of SHA-256(JCS(writ)) as the challenge", async () => {
    const app = await makeApp();
    const { status, body } = await post(app, "/sign/options", {});
    expect(status).toBe(200);
    const writ = body.writ as Record<string, unknown>;
    const { nonce, ...rest } = writ;
    expect(typeof nonce).toBe("string");
    expect(rest).toEqual(SAMPLE_WRIT);
    expect(body.canonical).toBe(jcs(writ));
    const expected = toBase64Url(hashJcs(writ));
    expect(body.challenge).toBe(expected);
    const options = body.options as Record<string, unknown>;
    expect(options.challenge).toBe(expected);
    expect(fromBase64Url(expected)).toHaveLength(32);
    expect(options.userVerification).toBe("required");
    expect(options.rpId).toBe("localhost");
  });

  it("issues a fresh challenge per Writ and passes hints for the chosen route", async () => {
    const app = await makeApp();
    const a = await post(app, "/sign/options", { via: "phone" });
    const b = await post(app, "/sign/options", { via: "this-device" });
    expect(a.body.challenge).not.toBe(b.body.challenge);
    expect((a.body.options as Record<string, unknown>).hints).toEqual(["hybrid"]);
    expect((b.body.options as Record<string, unknown>).hints).toEqual(["client-device"]);
  });

  it("registration options carry the configured RP ID, required UV and preferred resident key", async () => {
    const app = await makeApp({ rpID: "writ-gateway.onrender.com", rpName: "Writ Spike", origins: ["https://writ-gateway.onrender.com"] });
    const { status, body } = await post(app, "/register/options", { authenticator: "phone" });
    expect(status).toBe(200);
    expect(body.rp).toEqual({ name: "Writ Spike", id: "writ-gateway.onrender.com" });
    expect(body.authenticatorSelection).toMatchObject({ residentKey: "preferred", userVerification: "required" });
    expect(body.hints).toEqual(["hybrid"]);
  });

  it("rejects unknown fields in request envelopes", async () => {
    const app = await makeApp();
    const { status, body } = await post(app, "/sign/options", { via: "any", amount: 1 });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_request");
  });
});

describe("spike S6 verification", () => {
  it("rejects an assertion for an unknown credential", async () => {
    const app = await makeApp();
    const stranger = newAuthenticator("platform", ["internal"]);
    const { verify } = await signOnce(app, stranger, "localhost", "http://localhost", DESKTOP_CHROME);
    expect(verify.status).toBe(404);
    expect(verify.body.error).toBe("unknown_credential");
  });

  it("registers, signs the Writ hash, refuses replay, and fails the tamper check", async () => {
    const events: PasskeySpikeEvent[] = [];
    const app = await makeApp({ rpID: "localhost", origins: [], onEvent: (e) => events.push(e) });
    const auth = newAuthenticator("platform", ["internal"]);
    const reg = await register(app, auth, "localhost", "http://localhost");
    expect(reg.authenticatorName).toBe("Windows Hello");
    expect(reg.userVerified).toBe(true);

    const { opts, response, verify } = await signOnce(app, auth, "localhost", "http://localhost", DESKTOP_CHROME);
    expect(verify.status, JSON.stringify(verify.body)).toBe(200);
    expect(verify.body.hashHex).toBe(Buffer.from(hashJcs(opts.writ)).toString("hex"));
    expect(verify.body.flags).toEqual({ up: true, uv: true, be: false, bs: false });
    expect(verify.body.counter).toBe(1);
    expect(verify.body.origin).toBe("http://localhost");

    const replay = await post(app, "/sign/verify", { response }, DESKTOP_CHROME);
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("unknown_challenge");

    const tamper = await post(app, "/sign/verify-tampered", { response });
    expect(tamper.status).toBe(200);
    expect(tamper.body.ok).toBe(true);
    const tampered = tamper.body.tampered as Record<string, unknown>;
    const forged = tamper.body.forged as Record<string, unknown>;
    const control = tamper.body.control as Record<string, unknown>;
    expect(tampered.verified).toBe(false);
    expect(String(tampered.error)).toMatch(/challenge/);
    // Challenge, origin, RP ID, flags and counter all match here; only the signature check can reject it.
    expect(forged.verified).toBe(false);
    expect(forged.error).toBe("signature did not verify");
    expect(control.verified).toBe(true);
    expect(tampered.hashHex).toBe(Buffer.from(hashJcs(tamperWrit(opts.writ as SpikeWrit))).toString("hex"));

    expect(events.map((e) => e.type)).toEqual(["registered", "signed", "tamper"]);

    const report = (await app.inject({ method: "GET", url: `${BASE}/report` })).json() as Record<string, unknown>;
    expect(report.verdict).toBe("INCOMPLETE");
    expect((report.missing as string[]).some((m) => m.includes("local origin only"))).toBe(true);
    expect(String(report.markdown)).toContain(String(verify.body.hashHex));
  });

  it("rejects an assertion without user verification", async () => {
    const app = await makeApp();
    const auth = newAuthenticator("platform", ["internal"]);
    await register(app, auth, "localhost", "http://localhost");
    const opts = await post(app, "/sign/options", {});
    const response = assertion(auth, "localhost", String(opts.body.challenge), "http://localhost", FLAG_UP);
    const verify = await post(app, "/sign/verify", { response });
    expect(verify.status).toBe(400);
    expect(String(verify.body.message)).toMatch(/[Uu]ser verification/);
  });

  it("rejects an assertion from an origin the server does not expect", async () => {
    const app = await makeApp();
    const auth = newAuthenticator("platform", ["internal"]);
    await register(app, auth, "localhost", "http://localhost");
    const opts = await post(app, "/sign/options", {});
    const response = assertion(auth, "localhost", String(opts.body.challenge), "https://evil.example");
    const verify = await post(app, "/sign/verify", { response });
    expect(verify.status).toBe(400);
    expect(String(verify.body.message)).toMatch(/origin/);
  });

  it("reports PASS once desktop Chrome and a phone sign on the deployed origin and the tamper check holds", async () => {
    const rpID = "writ-gateway.onrender.com";
    const origin = `https://${rpID}`;
    const app = await makeApp({ rpID, origins: [origin] });
    const desktop = newAuthenticator("platform", ["internal"]);
    const phone = newAuthenticator("cross-platform", ["hybrid", "internal"]);
    await register(app, desktop, rpID, origin);
    await register(app, phone, rpID, origin);

    const first = await signOnce(app, desktop, rpID, origin, DESKTOP_CHROME);
    expect(first.verify.status).toBe(200);
    const second = await signOnce(app, phone, rpID, origin, DESKTOP_CHROME);
    expect(second.verify.status).toBe(200);
    expect((await post(app, "/sign/verify-tampered", { response: first.response })).body.ok).toBe(true);

    const report = (await app.inject({ method: "GET", url: `${BASE}/report` })).json() as Record<string, unknown>;
    expect(report.missing).toEqual([]);
    expect(report.verdict).toBe("PASS");
    expect(String(report.markdown)).toContain("### S6 result: PASS");
    expect(String(report.markdown)).toContain("Windows Hello");
  });

  it("counts a signature made with the page opened on the phone itself", async () => {
    const rpID = "writ-gateway.onrender.com";
    const origin = `https://${rpID}`;
    const app = await makeApp({ rpID, origins: [origin] });
    const phone = newAuthenticator("platform", ["hybrid", "internal"]);
    await register(app, phone, rpID, origin, ANDROID_CHROME);
    const { verify } = await signOnce(app, phone, rpID, origin, ANDROID_CHROME);
    expect(verify.status).toBe(200);
    const report = (await app.inject({ method: "GET", url: `${BASE}/report` })).json() as { conditions: { id: string; met: boolean }[] };
    expect(report.conditions.find((c) => c.id === "phone")?.met).toBe(true);
    expect(report.conditions.find((c) => c.id === "desktop")?.met).toBe(false);
  });
});

describe("spike S6 config and helpers", () => {
  it("reads RP ID, RP name and origins from env, normalizing URLs to origins", () => {
    const config = resolvePasskeySpikeConfig({
      env: {
        WEBAUTHN_RP_ID: "writ-gateway.onrender.com",
        APP_BASE_URL: "https://writ-web.onrender.com/wallet",
        GATEWAY_BASE_URL: "https://writ-gateway.onrender.com/",
        RENDER_EXTERNAL_URL: "https://writ-gateway.onrender.com",
      },
    });
    expect(config).toEqual({
      rpID: "writ-gateway.onrender.com",
      rpName: "Writ",
      origins: ["https://writ-web.onrender.com", "https://writ-gateway.onrender.com"],
    });
  });

  it("defaults to localhost and rejects an RP ID that is not a bare hostname", () => {
    expect(resolvePasskeySpikeConfig({ env: {} })).toEqual({ rpID: "localhost", rpName: "Writ", origins: [] });
    expect(() => resolvePasskeySpikeConfig({ env: { WEBAUTHN_RP_ID: "https://writ.example" } })).toThrow(/bare lowercase hostname/);
    expect(() => resolvePasskeySpikeConfig({ env: { APP_BASE_URL: "writ.example" } })).toThrow(/APP_BASE_URL/);
  });

  it("only enables spikes on an explicit flag", () => {
    expect(spikesEnabled({ ENABLE_SPIKES: "true" })).toBe(true);
    expect(spikesEnabled({ ENABLE_SPIKES: "1" })).toBe(false);
    expect(spikesEnabled({})).toBe(false);
  });

  it("recognizes loopback hosts only", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "[::1]", "::1"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["192.168.1.10", "writ-gateway.onrender.com", "localhost.evil.example"]) expect(isLoopbackHost(host)).toBe(false);
  });

  it("labels clients from client hints and user agents", () => {
    expect(
      describeClient({ userAgent: DESKTOP_CHROME["user-agent"], mobileHint: "?0", platformHint: '"Windows"' }),
    ).toEqual({ browser: "Chrome", os: "Windows", mobile: false });
    expect(
      describeClient({
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      }),
    ).toEqual({ browser: "Safari", os: "iOS", mobile: true });
    expect(
      describeClient({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
      }).browser,
    ).toBe("Edge");
  });

  it("an empty report is INCOMPLETE and names the fallback", () => {
    const report = buildReport(
      { signatures: [], tamperChecks: [], credentials: new Map() },
      { rpID: "localhost", rpName: "Writ", origins: [] },
      new Date("2026-11-01T00:00:00Z"),
    );
    expect(report.verdict).toBe("INCOMPLETE");
    expect(report.missing).toHaveLength(3);
    expect(report.markdown).toContain("Ed25519 device key");
  });
});
