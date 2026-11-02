// Wallet sessions, passkey registration and sign-in, device keys and the address book
// (owner: api stream; gateway routes in apps/gateway/src/routes/auth.ts). Every WebAuthn ceremony
// runs in the Wallet on APP_BASE_URL; the gateway only verifies (plan §6.6).
import { z } from "zod";
import { idSchema } from "../ids";
import { singleLineText } from "../writ";
import {
  AuthenticationResponseJsonSchema,
  Base64UrlSchema,
  localIdSchema,
  RegistrationResponseJsonSchema,
  TenantIdSchema,
  TimestampSchema,
  WebAuthnCreationOptionsSchema,
  WebAuthnRequestOptionsSchema,
} from "./common";

export const SESSION_KINDS = ["user", "judge"] as const;
export const SessionKindSchema = z.enum(SESSION_KINDS);
export type SessionKind = z.infer<typeof SessionKindSchema>;

export const UserViewSchema = z.strictObject({
  user_id: idSchema("usr"),
  display_name: singleLineText(60),
  /** Seeded judge-mode account ("Ana"); the Wallet labels it. */
  demo: z.boolean(),
});
export type UserView = z.infer<typeof UserViewSchema>;

export const SessionViewSchema = z.strictObject({
  user: UserViewSchema,
  tenant_id: TenantIdSchema,
  kind: SessionKindSchema,
  expires_at: TimestampSchema,
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const ChallengeIdSchema = localIdSchema("chl");

// POST /v1/auth/register/options
export const RegisterOptionsRequestSchema = z.strictObject({ display_name: singleLineText(60) });
export type RegisterOptionsRequest = z.infer<typeof RegisterOptionsRequestSchema>;
export const RegisterOptionsResponseSchema = z.strictObject({
  challenge_id: ChallengeIdSchema,
  options: WebAuthnCreationOptionsSchema,
});
export type RegisterOptionsResponse = z.infer<typeof RegisterOptionsResponseSchema>;

// POST /v1/auth/register/verify → SessionView + Set-Cookie
export const RegisterVerifyRequestSchema = z.strictObject({
  challenge_id: ChallengeIdSchema,
  response: RegistrationResponseJsonSchema,
});
export type RegisterVerifyRequest = z.infer<typeof RegisterVerifyRequestSchema>;

// POST /v1/auth/login/options (discoverable credentials: no user name needed)
export const LoginOptionsResponseSchema = z.strictObject({
  challenge_id: ChallengeIdSchema,
  options: WebAuthnRequestOptionsSchema,
});
export type LoginOptionsResponse = z.infer<typeof LoginOptionsResponseSchema>;

// POST /v1/auth/login/verify → SessionView + Set-Cookie
export const LoginVerifyRequestSchema = z.strictObject({
  challenge_id: ChallengeIdSchema,
  response: AuthenticationResponseJsonSchema,
});
export type LoginVerifyRequest = z.infer<typeof LoginVerifyRequestSchema>;

export const PasskeyViewSchema = z.strictObject({
  passkey_id: localIdSchema("psk"),
  credential_id: Base64UrlSchema,
  backed_up: z.boolean(),
  created_at: TimestampSchema,
  last_used_at: TimestampSchema.nullable(),
});
export type PasskeyView = z.infer<typeof PasskeyViewSchema>;

export const DeviceKeyViewSchema = z.strictObject({
  device_key_id: localIdSchema("dvk"),
  label: singleLineText(60),
  /** The clearly labeled judge-mode demo key (plan §18). */
  demo: z.boolean(),
  /** Raw 32-byte Ed25519 public key, base64url. */
  public_key: Base64UrlSchema.length(43),
  created_at: TimestampSchema,
});
export type DeviceKeyView = z.infer<typeof DeviceKeyViewSchema>;

// POST /v1/auth/device-keys (S6 fallback signer: WebCrypto Ed25519 in the Wallet)
export const RegisterDeviceKeyRequestSchema = z.strictObject({
  public_key: Base64UrlSchema.length(43),
  label: singleLineText(60),
});
export type RegisterDeviceKeyRequest = z.infer<typeof RegisterDeviceKeyRequestSchema>;

// POST /v1/auth/device-wallet: a wallet with no passkey, for browsers without an authenticator (S6 fallback).
export const CreateDeviceWalletRequestSchema = z.strictObject({
  display_name: singleLineText(60),
  public_key: Base64UrlSchema.length(43),
  label: singleLineText(60),
});
export type CreateDeviceWalletRequest = z.infer<typeof CreateDeviceWalletRequestSchema>;

/** What agents and most screens see of an address: never the street (threats T2, T6). */
export const AddressRefSchema = z.strictObject({ address_id: idSchema("adr"), label: singleLineText(40) });
export type AddressRef = z.infer<typeof AddressRefSchema>;

/** The owner's own view (settings screen only). */
export const AddressDetailSchema = z.strictObject({
  address_id: idSchema("adr"),
  label: singleLineText(40),
  line1: singleLineText(120),
  city: singleLineText(80),
  region: singleLineText(80).nullable(),
  postal: singleLineText(20),
  country: z.string().regex(/^[A-Z]{2}$/),
});
export type AddressDetail = z.infer<typeof AddressDetailSchema>;

// POST /v1/address-book
export const CreateAddressRequestSchema = AddressDetailSchema.omit({ address_id: true });
export type CreateAddressRequest = z.infer<typeof CreateAddressRequestSchema>;
export const AddressListResponseSchema = z.strictObject({ addresses: z.array(AddressDetailSchema).max(50) });

// GET /v1/me
export const MeResponseSchema = z.strictObject({
  session: SessionViewSchema,
  passkeys: z.array(PasskeyViewSchema).max(50),
  device_keys: z.array(DeviceKeyViewSchema).max(50),
  addresses: z.array(AddressRefSchema).max(50),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
