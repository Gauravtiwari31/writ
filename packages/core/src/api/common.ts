// Shared building blocks of the HTTP API contract ("@writ/core/api"). Everything on the wire is
// JSON with snake_case keys; money is minor units as decimal strings, never numbers (§22 rule 13);
// timestamps are Date#toISOString strings. Request schemas are strict (unknown fields are a 400);
// response schemas are strict too, so the Wallet notices any drift in tests.
import { z } from "zod";
import { IsoTimestampSchema } from "../writ";

/** Body of every non-2xx answer. `error` is a stable code (API_ERROR_CODES); `message` is for people. */
export const ApiErrorSchema = z.object({
  error: z.string().min(1).max(64),
  message: z.string().max(2000),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const API_ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "not_implemented",
  "database_unavailable",
  "ai_unavailable",
  "paypal_unconfigured",
  "paypal_not_connected",
  "webauthn_unconfigured",
  "channel3_unavailable",
  "idempotency_key_required",
  "signature_invalid",
  "internal_error",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const ULID_BODY = "[0-7][0-9a-hjkmnp-tv-z]{25}";

/**
 * Gateway-local row ids ("<prefix>_<ULID>", see apps/gateway/src/db/ids.ts) for rows that no
 * signed document references: dec, atk, dsp, psk, dvk, vlt, run, evl, cat, chl, tn.
 */
export function localIdSchema(prefix: string) {
  if (!/^[a-z]{2,4}$/.test(prefix)) throw new TypeError(`invalid id prefix: ${prefix}`);
  return z.string().regex(new RegExp(`^${prefix}_${ULID_BODY}$`), `expected a ${prefix}_ id`);
}

/** Tenant ids are opaque to clients ("tn_<ULID>" for wallets and judge visitors). */
export const TenantIdSchema = z.string().regex(/^[a-z0-9_]{1,64}$/, "tenant id");

export const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, "expected unpadded base64url");

export const TimestampSchema = IsoTimestampSchema;

/** Minor units with no length cap, for computed totals (input amounts use MinorAmountSchema). */
export const MinorDigitsSchema = z.string().regex(/^(0|[1-9][0-9]*)$/, "minor units as a non-negative integer string");

const TransportsSchema = z.array(z.string().max(32)).max(10);

/** PublicKeyCredentialRequestOptionsJSON as @simplewebauthn/server generates and /browser consumes it. */
export const WebAuthnRequestOptionsSchema = z.looseObject({
  challenge: Base64UrlSchema,
  rpId: z.string().min(1).max(253).optional(),
  timeout: z.int().positive().optional(),
  allowCredentials: z
    .array(z.looseObject({ id: Base64UrlSchema, type: z.literal("public-key"), transports: TransportsSchema.optional() }))
    .max(50)
    .optional(),
  userVerification: z.enum(["required", "preferred", "discouraged"]).optional(),
});
export type WebAuthnRequestOptions = z.infer<typeof WebAuthnRequestOptionsSchema>;

/** PublicKeyCredentialCreationOptionsJSON (registration), produced by @simplewebauthn/server. */
export const WebAuthnCreationOptionsSchema = z.looseObject({
  challenge: Base64UrlSchema,
  rp: z.looseObject({ name: z.string().min(1), id: z.string().min(1).optional() }),
  user: z.looseObject({ id: Base64UrlSchema, name: z.string().min(1), displayName: z.string() }),
  pubKeyCredParams: z.array(z.looseObject({ alg: z.int(), type: z.literal("public-key") })).min(1),
  timeout: z.int().positive().optional(),
});
export type WebAuthnCreationOptions = z.infer<typeof WebAuthnCreationOptionsSchema>;

// Browser → gateway credential JSON. Produced by @simplewebauthn/browser, not by us, so unknown
// fields are tolerated (loose); the gateway re-verifies everything with @simplewebauthn/server.
const BrowserB64 = Base64UrlSchema.max(16_384);
const ExtensionOutputsSchema = z.record(z.string(), z.unknown());

export const RegistrationResponseJsonSchema = z.looseObject({
  id: BrowserB64,
  rawId: BrowserB64,
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: BrowserB64,
    attestationObject: BrowserB64,
    transports: TransportsSchema.optional(),
  }),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: ExtensionOutputsSchema,
});
export type RegistrationResponseJson = z.infer<typeof RegistrationResponseJsonSchema>;

export const AuthenticationResponseJsonSchema = z.looseObject({
  id: BrowserB64,
  rawId: BrowserB64,
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: BrowserB64,
    authenticatorData: BrowserB64,
    signature: BrowserB64,
    userHandle: BrowserB64.optional(),
  }),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: ExtensionOutputsSchema,
});
export type AuthenticationResponseJson = z.infer<typeof AuthenticationResponseJsonSchema>;
