// Spike S6 (plan §17): can a passkey sign an arbitrary hash, SHA-256(JCS(Writ)), on desktop Chrome
// and on a phone, and can the server verify it? SPIKE ONLY, not product code: credentials,
// challenges and results live in process memory and vanish on restart. The gateway mounts this only
// when ENABLE_SPIKES=true; scripts/spike-passkey.ts mounts it standalone.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationExtensionsClientOutputs,
  type AuthenticationResponseJSON,
  type AuthenticatorAttachment,
  type CredentialDeviceType,
  type PublicKeyCredentialHint,
  type Uint8Array_,
} from "@simplewebauthn/server";
import { decodeClientDataJSON, isoBase64URL, parseAuthenticatorData } from "@simplewebauthn/server/helpers";
import { hashJcs, hashJcsHex, jcs, toBase64Url, toHex, utf8 } from "@writ/core";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { PASSKEY_PAGE_CSP, renderPasskeyPage, SIMPLEWEBAUTHN_BROWSER_CDN } from "./passkey-page";

export const PASSKEY_SPIKE_PREFIX = "/spikes/passkey";

const CEREMONY_TIMEOUT_MS = 120_000;
// A pending challenge outlives the ceremony timeout a little so a slow phone/QR handoff still verifies.
const PENDING_TTL_MS = 5 * 60_000;
// The spike may sit on a public Render URL, so every in-memory collection is bounded.
const MAX_PENDING = 200;
const MAX_CREDENTIALS = 50;
const MAX_EVENTS = 100;

/**
 * Spike-only hero Writ (plan §4 scene 3). Deliberately NOT the production schema, which
 * packages/core owns. Money is minor units as strings, like the real Writ.
 */
export const SAMPLE_WRIT = {
  spec: "writ-spike-s6/0",
  principal: "Ana (sandbox buyer)",
  purpose: "Pottery-themed gift for my sister",
  currency: "USD",
  budget: { limit_minor: "6000", approval_above_minor: "4000", max_orders: 1 },
  categories: {
    allow: ["pottery", "ceramics", "gifts"],
    deny: ["gift_cards", "protection_plans", "subscriptions"],
  },
  ship_to: { locked: true, label: "Home (Austin, TX)" },
  deliver_by: "2026-11-20",
  expires_at: "2026-11-08T23:59:59Z",
  agents: ["atlas"],
};

export type SampleWrit = typeof SAMPLE_WRIT;
/** The Writ as signed: the sample plus a server nonce, so every challenge is fresh (replay safety). */
export type SpikeWrit = SampleWrit & { nonce: string };

export const TAMPER = { path: "budget.limit_minor", from: "6000", to: "9000" } as const;

export function tamperWrit(writ: SpikeWrit): SpikeWrit {
  return { ...writ, budget: { ...writ.budget, limit_minor: TAMPER.to } };
}

// Subset of the community list github.com/passkeydeveloper/passkey-authenticator-aaguids.
const KNOWN_AAGUIDS: Readonly<Record<string, string>> = {
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "Apple Passwords (iCloud Keychain)",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain (Managed)",
  "53414d53-554e-4700-0000-000000000000": "Samsung Pass",
  "d3452668-01fd-4c12-926c-83a4204853aa": "Microsoft Password Manager",
  "771b48fd-d3d4-4f74-9232-fc157ab0507a": "Edge on Mac",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
  "50726f74-6f6e-5061-7373-50726f746f6e": "Proton Pass",
};

export function authenticatorName(aaguid: string): string {
  if (aaguid === "00000000-0000-0000-0000-000000000000") return "unknown (authenticator did not disclose an AAGUID)";
  return KNOWN_AAGUIDS[aaguid] ?? `unknown (AAGUID ${aaguid})`;
}

export interface PasskeySpikeOptions {
  /** Default: WEBAUTHN_RP_ID, else "localhost". Must be the page's host or a registrable parent of it. */
  rpID?: string;
  /** Default: WEBAUTHN_RP_NAME, else "Writ". */
  rpName?: string;
  /**
   * Origins accepted in clientDataJSON. Default: APP_BASE_URL, GATEWAY_BASE_URL and
   * RENDER_EXTERNAL_URL (set by Render). A loopback request origin is always accepted as well.
   */
  origins?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  /** Live progress for scripts/spike-passkey.ts. */
  onEvent?: (event: PasskeySpikeEvent) => void;
}

export interface PasskeySpikeConfig {
  rpID: string;
  rpName: string;
  origins: string[];
}

const RP_ID_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function toOrigin(value: string, source: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${source} must be an absolute URL such as https://writ-gateway.onrender.com`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${source} must be an http(s) URL`);
  return url.origin;
}

export function resolvePasskeySpikeConfig(options: PasskeySpikeOptions = {}): PasskeySpikeConfig {
  const env = options.env ?? process.env;
  const rpID = options.rpID ?? nonEmpty(env.WEBAUTHN_RP_ID) ?? "localhost";
  if (!RP_ID_RE.test(rpID)) {
    throw new Error(`WEBAUTHN_RP_ID must be a bare lowercase hostname (no scheme, port or path), got "${rpID}"`);
  }
  const rpName = options.rpName ?? nonEmpty(env.WEBAUTHN_RP_NAME) ?? "Writ";
  const origins = new Set<string>();
  if (options.origins) {
    options.origins.forEach((origin, i) => origins.add(toOrigin(origin, `origins[${i}]`)));
  } else {
    for (const name of ["APP_BASE_URL", "GATEWAY_BASE_URL", "RENDER_EXTERNAL_URL"]) {
      const value = nonEmpty(env[name]);
      if (value !== undefined) origins.add(toOrigin(value, name));
    }
  }
  return { rpID, rpName, origins: [...origins] };
}

/** The flag the gateway checks before registering this plugin. */
export function spikesEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.ENABLE_SPIKES === "true";
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export interface ClientInfo {
  browser: string;
  os: string;
  mobile: boolean;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Coarse device label for the report. User-Agent client hints first, UA string as fallback. */
export function describeClient(headers: { userAgent?: string; mobileHint?: string; platformHint?: string }): ClientInfo {
  const ua = headers.userAgent ?? "";
  const mobile =
    headers.mobileHint !== undefined ? headers.mobileHint.trim() === "?1" : /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const platformHint = headers.platformHint?.replace(/"/g, "").trim();
  const os =
    platformHint !== undefined && platformHint !== ""
      ? platformHint
      : /Windows NT/.test(ua)
        ? "Windows"
        : /Android/.test(ua)
          ? "Android"
          : /iPhone|iPad|iPod/.test(ua)
            ? "iOS"
            : /Mac OS X/.test(ua)
              ? "macOS"
              : /CrOS/.test(ua)
                ? "ChromeOS"
                : /Linux/.test(ua)
                  ? "Linux"
                  : "unknown";
  const browser = /Edg(?:A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /SamsungBrowser\//.test(ua)
        ? "Samsung Internet"
        : /CriOS\/|Chrome\//.test(ua)
          ? "Chrome"
          : /FxiOS\/|Firefox\//.test(ua)
            ? "Firefox"
            : /Safari\//.test(ua)
              ? "Safari"
              : "unknown";
  return { browser, os, mobile };
}

function clientOf(request: FastifyRequest): ClientInfo {
  return describeClient({
    userAgent: header(request, "user-agent"),
    mobileHint: header(request, "sec-ch-ua-mobile"),
    platformHint: header(request, "sec-ch-ua-platform"),
  });
}

// ---- inbound contracts ----------------------------------------------------------------------

const B64URL = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]+$/, "expected unpadded base64url");
const ExtensionOutputs = z.custom<AuthenticationExtensionsClientOutputs>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  "expected an object",
);
const Attachment = z.enum(["platform", "cross-platform"]);

// The credential JSON is produced by the browser library, not by us, so unknown fields are tolerated
// (loose); our own request envelopes are strict.
const RegistrationResponseSchema = z.looseObject({
  id: B64URL,
  rawId: B64URL,
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: B64URL,
    attestationObject: B64URL,
    authenticatorData: B64URL.optional(),
    transports: z.array(z.string().max(32)).max(10).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: B64URL.optional(),
  }),
  authenticatorAttachment: Attachment.optional(),
  clientExtensionResults: ExtensionOutputs,
});

const AuthenticationResponseSchema = z.looseObject({
  id: B64URL,
  rawId: B64URL,
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: B64URL,
    authenticatorData: B64URL,
    signature: B64URL,
    userHandle: B64URL.optional(),
  }),
  authenticatorAttachment: Attachment.optional(),
  clientExtensionResults: ExtensionOutputs,
});

const RegisterOptionsBody = z.strictObject({ authenticator: z.enum(["platform", "phone", "any"]).default("any") });
const RegisterVerifyBody = z.strictObject({ response: RegistrationResponseSchema });
const SignOptionsBody = z.strictObject({ via: z.enum(["any", "this-device", "phone"]).default("any") });
const AssertionBody = z.strictObject({ response: AuthenticationResponseSchema });

type SignVia = z.output<typeof SignOptionsBody>["via"];

const SIGN_HINTS: Record<SignVia, PublicKeyCredentialHint[] | undefined> = {
  any: undefined,
  "this-device": ["client-device"],
  phone: ["hybrid"],
};

// ---- in-memory state --------------------------------------------------------------------------

interface StoredCredential {
  id: string;
  publicKey: Uint8Array_;
  counter: number;
  transports: string[];
  aaguid: string;
  authenticatorName: string;
  deviceType: CredentialDeviceType;
  backedUp: boolean;
  attachment: AuthenticatorAttachment | undefined;
  fmt: string;
  registeredAt: string;
  client: ClientInfo;
}

interface PendingSignature {
  writ: SpikeWrit;
  via: SignVia;
  expiresAt: number;
}

interface SignedRecord {
  writ: SpikeWrit;
  response: AuthenticationResponseJSON;
  credentialId: string;
  /** Counter before this assertion, so re-verification in the tamper check isolates the hash. */
  counterBefore: number;
}

export interface AuthenticatorFlags {
  up: boolean;
  uv: boolean;
  be: boolean;
  bs: boolean;
}

export interface SignatureEvent {
  at: string;
  credentialId: string;
  authenticatorName: string;
  hashHex: string;
  challenge: string;
  flags: AuthenticatorFlags;
  counter: number;
  attachment: AuthenticatorAttachment | undefined;
  transports: string[];
  deviceType: CredentialDeviceType;
  backedUp: boolean;
  origin: string;
  rpID: string;
  client: ClientInfo;
  /** Desktop Chrome with its platform authenticator (plan §17 S6 DoD, first half). */
  desktop: boolean;
  /** A phone signed: hybrid/QR from a desktop, or the page opened on the phone itself. */
  phone: boolean;
  /** Verified on an HTTPS, non-loopback origin (the Render domain). */
  deployed: boolean;
}

export interface TamperEvent {
  at: string;
  ok: boolean;
  credentialId: string;
  originalHashHex: string;
  tamperedHashHex: string;
  tamperedRejected: boolean;
  forgedRejected: boolean;
  controlVerified: boolean;
  tamperedError: string | undefined;
  forgedError: string | undefined;
  controlError: string | undefined;
}

export interface CredentialSummary {
  credentialId: string;
  authenticatorName: string;
  aaguid: string;
  authenticatorAttachment: AuthenticatorAttachment | undefined;
  transports: string[];
  credentialDeviceType: CredentialDeviceType;
  credentialBackedUp: boolean;
  fmt: string;
  client: ClientInfo;
}

export type PasskeySpikeEvent =
  | { type: "registered"; credential: CredentialSummary; userVerified: boolean }
  | { type: "signed"; signature: SignatureEvent }
  | { type: "tamper"; check: TamperEvent }
  | { type: "rejected"; stage: "register" | "sign"; error: string };

interface SpikeState {
  userID: Uint8Array_;
  pendingRegistrations: Map<string, number>;
  pendingSignatures: Map<string, PendingSignature>;
  signed: Map<string, SignedRecord>;
  credentials: Map<string, StoredCredential>;
  signatures: SignatureEvent[];
  tamperChecks: TamperEvent[];
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

function pushBounded<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
}

/** Single use: a challenge is removed whether or not the ceremony that presents it verifies. */
function takePending<V extends { expiresAt: number }>(map: Map<string, V>, key: string, now: number): V | undefined {
  const value = map.get(key);
  map.delete(key);
  return value !== undefined && value.expiresAt > now ? value : undefined;
}

// ---- report -----------------------------------------------------------------------------------

export interface SpikeCondition {
  id: "desktop" | "phone" | "tamper";
  label: string;
  met: boolean;
  seenLocally: boolean;
}

export interface PasskeySpikeReport {
  verdict: "PASS" | "INCOMPLETE";
  generatedAt: string;
  rpID: string;
  rpName: string;
  origins: string[];
  conditions: SpikeCondition[];
  missing: string[];
  signatures: SignatureEvent[];
  tamperChecks: TamperEvent[];
  credentials: CredentialSummary[];
  markdown: string;
}

function summarize(credential: StoredCredential): CredentialSummary {
  return {
    credentialId: credential.id,
    authenticatorName: credential.authenticatorName,
    aaguid: credential.aaguid,
    authenticatorAttachment: credential.attachment,
    transports: credential.transports,
    credentialDeviceType: credential.deviceType,
    credentialBackedUp: credential.backedUp,
    fmt: credential.fmt,
    client: credential.client,
  };
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function short(id: string, keep = 16): string {
  return id.length > keep ? `${id.slice(0, keep)}...` : id;
}

function flagsText(flags: AuthenticatorFlags): string {
  return `UP=${flags.up ? 1 : 0} UV=${flags.uv ? 1 : 0} BE=${flags.be ? 1 : 0} BS=${flags.bs ? 1 : 0}`;
}

function clientText(client: ClientInfo): string {
  return `${client.browser} / ${client.os} (${client.mobile ? "mobile" : "desktop"})`;
}

const FALLBACK_TEXT =
  "If this cannot be closed inside the 1.5 h box, take the plan §17 S6 fallback: an Ed25519 device key " +
  '(WebCrypto, non-extractable, kept in IndexedDB) labeled "device key" in the UI.';

export function buildReport(state: Pick<SpikeState, "signatures" | "tamperChecks" | "credentials">, config: PasskeySpikeConfig, now: Date): PasskeySpikeReport {
  const sigs = state.signatures;
  const conditions: SpikeCondition[] = [
    {
      id: "desktop",
      label: "Desktop Chrome signs with its platform authenticator on the deployed HTTPS origin",
      met: sigs.some((s) => s.desktop && s.deployed),
      seenLocally: sigs.some((s) => s.desktop && !s.deployed),
    },
    {
      id: "phone",
      label: "A phone signs (QR/hybrid from the desktop, or this page opened on the phone) on the deployed HTTPS origin",
      met: sigs.some((s) => s.phone && s.deployed),
      seenLocally: sigs.some((s) => s.phone && !s.deployed),
    },
    {
      id: "tamper",
      label: "Tamper check: modified Writ and forged clientDataJSON rejected, original still verifies",
      met: state.tamperChecks.some((t) => t.ok),
      seenLocally: false,
    },
  ];
  const verdict = conditions.every((c) => c.met) ? "PASS" : "INCOMPLETE";
  const missing = conditions
    .filter((c) => !c.met)
    .map((c) => (c.seenLocally ? `${c.label} (so far verified on a local origin only)` : c.label));
  const credentials = [...state.credentials.values()].map(summarize);

  const lines: string[] = [];
  lines.push(`### S6 result: ${verdict}`);
  lines.push("");
  lines.push(
    `- Generated ${now.toISOString()} by \`apps/gateway/src/spikes/passkey.ts\` (in-memory spike). ` +
      `@simplewebauthn/server v14, @simplewebauthn/browser ${SIMPLEWEBAUTHN_BROWSER_CDN.version} (jsDelivr, SRI-pinned).`,
  );
  lines.push(
    `- RP ID \`${config.rpID}\`, RP name \`${config.rpName}\`, configured origins: ${
      config.origins.length > 0 ? config.origins.map((o) => `\`${o}\``).join(", ") : "none (loopback only)"
    }.`,
  );
  lines.push(
    "- WebAuthn challenge = the 32 raw bytes of SHA-256(JCS(Writ)). The server recomputes the hash from its own copy of the Writ " +
      "and verifies with `requireUserVerification: true`; each Writ carries a server nonce, so challenges are single-use.",
  );
  lines.push("");
  lines.push("| Condition | Status |");
  lines.push("|---|---|");
  for (const c of conditions) {
    lines.push(`| ${cell(c.label)} | ${c.met ? "met" : c.seenLocally ? "missing (local only so far)" : "missing"} |`);
  }
  lines.push("");
  if (sigs.length > 0) {
    lines.push("Verified signatures:");
    lines.push("");
    lines.push("| # | Time (UTC) | Client | Authenticator | Attachment | Transports | Flags | Counter | Origin | Writ hash (SHA-256) | Credential |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
    sigs.forEach((s, i) => {
      lines.push(
        `| ${i + 1} | ${s.at.replace("T", " ").replace(/\.\d+Z$/, "Z")} | ${cell(clientText(s.client))} | ${cell(s.authenticatorName)} | ` +
          `${s.attachment ?? "n/a"} | ${cell(s.transports.join(", ") || "n/a")} | ${flagsText(s.flags)} | ${s.counter} | ` +
          `${cell(s.origin)} | \`${s.hashHex}\` | \`${short(s.credentialId)}\` |`,
      );
    });
    lines.push("");
  } else {
    lines.push("No signature verified yet.");
    lines.push("");
  }
  if (state.tamperChecks.length > 0) {
    lines.push(`Tamper checks (\`${TAMPER.path}\` ${TAMPER.from} -> ${TAMPER.to}, same assertion):`);
    lines.push("");
    lines.push("| # | Time (UTC) | Tampered Writ | Forged clientDataJSON | Original Writ | Result |");
    lines.push("|---|---|---|---|---|---|");
    state.tamperChecks.forEach((t, i) => {
      lines.push(
        `| ${i + 1} | ${t.at.replace("T", " ").replace(/\.\d+Z$/, "Z")} | ${t.tamperedRejected ? "rejected" : "VERIFIED (bad)"} | ` +
          `${t.forgedRejected ? "rejected" : "VERIFIED (bad)"} | ${t.controlVerified ? "verified" : "REJECTED (bad)"} | ${t.ok ? "OK" : "FAIL"} |`,
      );
    });
    lines.push("");
  }
  if (verdict === "PASS") {
    lines.push(
      "**Decision: PASS.** Passkeys sign SHA-256(JCS(Writ)) as the raw WebAuthn challenge on desktop Chrome and on a phone, " +
        "on the deployed domain, and the server verifies them. P0-1/P0-6 use @simplewebauthn with challenge = hash bytes.",
    );
  } else {
    lines.push(`**Decision: not PASS yet.** Missing: ${missing.join("; ")}. ${FALLBACK_TEXT}`);
  }

  return {
    verdict,
    generatedAt: now.toISOString(),
    rpID: config.rpID,
    rpName: config.rpName,
    origins: config.origins,
    conditions,
    missing,
    signatures: sigs,
    tamperChecks: state.tamperChecks,
    credentials,
    markdown: lines.join("\n"),
  };
}

// ---- plugin -----------------------------------------------------------------------------------

function sendError(reply: FastifyReply, status: number, error: string, message: string): FastifyReply {
  return reply.code(status).send({ error, message });
}

type Parsed<T> = { ok: true; data: T } | { ok: false; message: string };

function parseBody<S extends z.ZodType>(schema: S, body: unknown): Parsed<z.output<S>> {
  const result = schema.safeParse(body ?? {});
  return result.success ? { ok: true, data: result.data } : { ok: false, message: z.prettifyError(result.error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function challengeOf(clientDataJSON: string): string | undefined {
  try {
    const challenge = decodeClientDataJSON(clientDataJSON).challenge;
    return typeof challenge === "string" && challenge !== "" ? challenge : undefined;
  } catch {
    return undefined;
  }
}

/** Rewrites the challenge inside clientDataJSON, as an attacker would to claim a different Writ was signed. */
function forgeClientData(clientDataJSON: string, challenge: string): string {
  const parsed: unknown = JSON.parse(isoBase64URL.toUTF8String(clientDataJSON));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("clientDataJSON is not an object");
  return toBase64Url(utf8(JSON.stringify({ ...parsed, challenge })));
}

function isDeployedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && !isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

type AssertionCheck =
  | { verified: true; newCounter: number; origin: string; rpID: string; deviceType: CredentialDeviceType; backedUp: boolean }
  | { verified: false; error: string };

export const passkeySpikePlugin: FastifyPluginAsync<PasskeySpikeOptions> = async (app, options) => {
  const config = resolvePasskeySpikeConfig(options);
  await app.register(
    async (scope) => {
      registerRoutes(scope, config, options.onEvent);
    },
    { prefix: PASSKEY_SPIKE_PREFIX },
  );
};

function registerRoutes(app: FastifyInstance, config: PasskeySpikeConfig, onEvent: PasskeySpikeOptions["onEvent"]): void {
  // Full prefix including any outer prefix; the page builds its fetch URLs from it.
  const basePath = app.prefix;
  const sampleHashHex = hashJcsHex(SAMPLE_WRIT);
  const state: SpikeState = {
    // One spike user per process, so re-registering the same authenticator is caught by excludeCredentials.
    userID: crypto.getRandomValues(new Uint8Array(16)),
    pendingRegistrations: new Map(),
    pendingSignatures: new Map(),
    signed: new Map(),
    credentials: new Map(),
    signatures: [],
    tamperChecks: [],
  };

  const emit = (event: PasskeySpikeEvent): void => {
    try {
      onEvent?.(event);
    } catch (error) {
      app.log.warn({ err: error }, "passkey spike onEvent listener failed");
    }
  };

  const expectedOrigins = (request: FastifyRequest): string[] => {
    const origins = new Set(config.origins);
    // Loopback only: trusting the Host header for a public hostname would let a proxy pick its own origin.
    if (isLoopbackHost(request.hostname)) origins.add(new URL(`${request.protocol}://${request.host}`).origin);
    return [...origins];
  };

  const checkAssertion = async (
    request: FastifyRequest,
    response: AuthenticationResponseJSON,
    expectedChallenge: string,
    credential: StoredCredential,
    counter: number,
  ): Promise<AssertionCheck> => {
    try {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: expectedOrigins(request),
        expectedRPID: config.rpID,
        credential: { id: credential.id, publicKey: credential.publicKey, counter, transports: credential.transports },
        requireUserVerification: true,
      });
      if (!result.verified) return { verified: false, error: "signature did not verify" };
      const info = result.authenticationInfo;
      return {
        verified: true,
        newCounter: info.newCounter,
        origin: info.origin,
        rpID: info.rpID,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
      };
    } catch (error) {
      return { verified: false, error: errorMessage(error) };
    }
  };

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-robots-tag", "noindex, nofollow");
    reply.header("cache-control", "no-store");
    return payload;
  });

  app.get("/", async (request, reply) => {
    const html = renderPasskeyPage({
      basePath,
      rpID: config.rpID,
      rpName: config.rpName,
      expectedOrigins: expectedOrigins(request),
      sampleWrit: SAMPLE_WRIT,
      sampleHashHex,
      tamper: { ...TAMPER },
    });
    return reply
      .header("content-security-policy", PASSKEY_PAGE_CSP)
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff")
      .type("text/html; charset=utf-8")
      .send(html);
  });

  app.post("/register/options", async (request, reply) => {
    const body = parseBody(RegisterOptionsBody, request.body);
    if (!body.ok) return sendError(reply, 400, "invalid_request", body.message);
    const kind = body.data.authenticator;
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpID,
      userName: "ana.spike-s6",
      userDisplayName: "Ana (spike S6)",
      userID: state.userID,
      timeout: CEREMONY_TIMEOUT_MS,
      attestationType: "none",
      excludeCredentials: [...state.credentials.values()].map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      preferredAuthenticatorType: kind === "platform" ? "localDevice" : kind === "phone" ? "remoteDevice" : undefined,
    });
    remember(state.pendingRegistrations, options.challenge, Date.now() + PENDING_TTL_MS, MAX_PENDING);
    return options;
  });

  app.post("/register/verify", async (request, reply) => {
    const body = parseBody(RegisterVerifyBody, request.body);
    if (!body.ok) return sendError(reply, 400, "invalid_request", body.message);
    const response = body.data.response;
    const challenge = challengeOf(response.response.clientDataJSON);
    if (challenge === undefined) return sendError(reply, 400, "invalid_request", "clientDataJSON is not decodable");
    const expiresAt = state.pendingRegistrations.get(challenge);
    state.pendingRegistrations.delete(challenge);
    if (expiresAt === undefined || expiresAt <= Date.now()) {
      return sendError(reply, 409, "unknown_challenge", "This registration was not started here, was already used or expired. Click Create again.");
    }
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: expectedOrigins(request),
        expectedRPID: config.rpID,
        requireUserVerification: true,
      });
    } catch (error) {
      emit({ type: "rejected", stage: "register", error: errorMessage(error) });
      return sendError(reply, 400, "verification_failed", errorMessage(error));
    }
    if (!verification.verified) {
      emit({ type: "rejected", stage: "register", error: "registration did not verify" });
      return sendError(reply, 400, "verification_failed", "registration did not verify");
    }
    const info = verification.registrationInfo;
    const stored: StoredCredential = {
      id: info.credential.id,
      publicKey: info.credential.publicKey,
      counter: info.credential.counter,
      transports: info.credential.transports ?? response.response.transports ?? [],
      aaguid: info.aaguid,
      authenticatorName: authenticatorName(info.aaguid),
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      attachment: response.authenticatorAttachment,
      fmt: info.fmt,
      registeredAt: new Date().toISOString(),
      client: clientOf(request),
    };
    remember(state.credentials, stored.id, stored, MAX_CREDENTIALS);
    const summary = summarize(stored);
    emit({ type: "registered", credential: summary, userVerified: info.userVerified });
    return { ...summary, userVerified: info.userVerified };
  });

  app.post("/sign/options", async (request, reply) => {
    const body = parseBody(SignOptionsBody, request.body);
    if (!body.ok) return sendError(reply, 400, "invalid_request", body.message);
    const via = body.data.via;
    const writ: SpikeWrit = { ...SAMPLE_WRIT, nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) };
    const hash = hashJcs(writ);
    const challenge = toBase64Url(hash);

    const all = [...state.credentials.values()];
    const preferred =
      via === "this-device"
        ? all.filter((c) => c.attachment === "platform" || c.transports.includes("internal"))
        : via === "phone"
          ? all.filter((c) => c.transports.includes("hybrid"))
          : all;
    // Nothing known for this route: leave allowCredentials empty so the browser offers discoverable passkeys.
    const allow = preferred.map((c) => ({ id: c.id, transports: c.transports }));

    const generated = await generateAuthenticationOptions({
      rpID: config.rpID,
      // Raw bytes, not a string: a string challenge would be UTF-8 encoded by the library.
      challenge: new Uint8Array(hash),
      userVerification: "required",
      timeout: CEREMONY_TIMEOUT_MS,
      allowCredentials: allow.length > 0 ? allow : undefined,
    });
    const hints = SIGN_HINTS[via];
    const options = hints ? { ...generated, hints } : generated;
    if (options.challenge !== challenge) {
      return sendError(reply, 500, "challenge_mismatch", "WebAuthn library did not encode the hash bytes as the challenge");
    }
    remember(state.pendingSignatures, challenge, { writ, via, expiresAt: Date.now() + PENDING_TTL_MS }, MAX_PENDING);
    return {
      writ,
      canonical: jcs(writ),
      hashHex: toHex(hash),
      challenge,
      options,
      expiresInMs: PENDING_TTL_MS,
    };
  });

  app.post("/sign/verify", async (request, reply) => {
    const body = parseBody(AssertionBody, request.body);
    if (!body.ok) return sendError(reply, 400, "invalid_request", body.message);
    const response: AuthenticationResponseJSON = body.data.response;
    const credential = state.credentials.get(response.id);
    if (!credential) {
      emit({ type: "rejected", stage: "sign", error: "unknown credential" });
      return sendError(
        reply,
        404,
        "unknown_credential",
        "This passkey is not registered with this server. The spike keeps passkeys in memory only: register again after a restart or redeploy.",
      );
    }
    const challenge = challengeOf(response.response.clientDataJSON);
    if (challenge === undefined) return sendError(reply, 400, "invalid_request", "clientDataJSON is not decodable");
    const pending = takePending(state.pendingSignatures, challenge, Date.now());
    if (!pending) {
      return sendError(reply, 409, "unknown_challenge", "No pending signature for this challenge (expired, already used, or the server restarted). Prepare the Writ again.");
    }

    // Re-derive the hash from the server's own copy of the Writ; never trust a hash sent by the client.
    const hash = hashJcs(pending.writ);
    const counterBefore = credential.counter;
    const check = await checkAssertion(request, response, toBase64Url(hash), credential, counterBefore);
    if (!check.verified) {
      emit({ type: "rejected", stage: "sign", error: check.error });
      return sendError(reply, 400, "verification_failed", check.error);
    }
    credential.counter = check.newCounter;
    credential.deviceType = check.deviceType;
    credential.backedUp = check.backedUp;

    const parsed = parseAuthenticatorData(isoBase64URL.toBuffer(response.response.authenticatorData));
    const flags: AuthenticatorFlags = { up: parsed.flags.up, uv: parsed.flags.uv, be: parsed.flags.be, bs: parsed.flags.bs };
    const attachment = response.authenticatorAttachment ?? credential.attachment;
    const client = clientOf(request);
    const event: SignatureEvent = {
      at: new Date().toISOString(),
      credentialId: credential.id,
      authenticatorName: credential.authenticatorName,
      hashHex: toHex(hash),
      challenge,
      flags,
      counter: check.newCounter,
      attachment,
      transports: credential.transports,
      deviceType: check.deviceType,
      backedUp: check.backedUp,
      origin: check.origin,
      rpID: check.rpID,
      client,
      desktop: !client.mobile && client.browser === "Chrome" && attachment === "platform",
      phone: client.mobile || (attachment === "cross-platform" && credential.transports.includes("hybrid")),
      deployed: isDeployedOrigin(check.origin),
    };
    pushBounded(state.signatures, event);
    remember(state.signed, challenge, { writ: pending.writ, response, credentialId: credential.id, counterBefore }, MAX_PENDING);
    emit({ type: "signed", signature: event });
    return {
      verified: true,
      hashHex: event.hashHex,
      challenge,
      flags,
      counter: event.counter,
      authenticatorAttachment: attachment,
      transports: credential.transports,
      authenticatorName: credential.authenticatorName,
      credentialDeviceType: event.deviceType,
      credentialBackedUp: event.backedUp,
      origin: event.origin,
      rpID: event.rpID,
      credentialId: credential.id,
      client,
    };
  });

  app.post("/sign/verify-tampered", async (request, reply) => {
    const body = parseBody(AssertionBody, request.body);
    if (!body.ok) return sendError(reply, 400, "invalid_request", body.message);
    const challenge = challengeOf(body.data.response.response.clientDataJSON);
    if (challenge === undefined) return sendError(reply, 400, "invalid_request", "clientDataJSON is not decodable");
    const signed = state.signed.get(challenge);
    if (!signed) return sendError(reply, 409, "not_signed", "Sign the Writ first: the tamper check re-verifies an assertion this server already accepted.");
    const credential = state.credentials.get(signed.credentialId);
    if (!credential) return sendError(reply, 404, "unknown_credential", "The passkey for this signature is no longer in memory.");

    // Re-check the assertion the server accepted (not the copy just posted), with the counter it had
    // before that assertion, so the only thing that changes between the three checks is the Writ hash.
    const response = signed.response;
    const originalHash = hashJcs(signed.writ);
    const tamperedHash = hashJcs(tamperWrit(signed.writ));
    const tamperedChallenge = toBase64Url(tamperedHash);

    const tampered = await checkAssertion(request, response, tamperedChallenge, credential, signed.counterBefore);
    let forged: AssertionCheck;
    try {
      const forgedResponse: AuthenticationResponseJSON = {
        ...response,
        response: { ...response.response, clientDataJSON: forgeClientData(response.response.clientDataJSON, tamperedChallenge) },
      };
      forged = await checkAssertion(request, forgedResponse, tamperedChallenge, credential, signed.counterBefore);
    } catch (error) {
      forged = { verified: false, error: errorMessage(error) };
    }
    const control = await checkAssertion(request, response, toBase64Url(originalHash), credential, signed.counterBefore);

    const event: TamperEvent = {
      at: new Date().toISOString(),
      ok: !tampered.verified && !forged.verified && control.verified,
      credentialId: credential.id,
      originalHashHex: toHex(originalHash),
      tamperedHashHex: toHex(tamperedHash),
      tamperedRejected: !tampered.verified,
      forgedRejected: !forged.verified,
      controlVerified: control.verified,
      tamperedError: tampered.verified ? undefined : tampered.error,
      forgedError: forged.verified ? undefined : forged.error,
      controlError: control.verified ? undefined : control.error,
    };
    pushBounded(state.tamperChecks, event);
    emit({ type: "tamper", check: event });
    return {
      ok: event.ok,
      tampered: { change: { ...TAMPER }, hashHex: event.tamperedHashHex, verified: tampered.verified, error: event.tamperedError },
      forged: { hashHex: event.tamperedHashHex, verified: forged.verified, error: event.forgedError },
      control: { hashHex: event.originalHashHex, verified: control.verified, error: event.controlError },
    };
  });

  app.get("/report", async () => buildReport(state, config, new Date()));
}
