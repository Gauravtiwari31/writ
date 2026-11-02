import { generateKeyPairSync, randomBytes, sign as nodeSign, type KeyObject } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import {
  concatBytes,
  DEVICE_SIGNATURE_DOMAIN,
  deviceSignatureMessage,
  draftToWritBody,
  fromBase64Url,
  generateDeviceKeyEd25519,
  sha256,
  signDeviceEd25519,
  toBase64Url,
  utf8,
  WritSignatureSchema,
  writHash,
  type DeviceEd25519Signature,
  type WebAuthnSignature,
  type WritBody,
} from "../src/index";
import {
  verifyDeviceEd25519,
  verifyWebAuthnOverHash,
  verifyWritSignature,
  type PasskeyCredential,
  type WebAuthnOverHashInput,
} from "../src/signatures/index";

const RP_ID = "wallet.writ.test";
const ORIGIN = "https://wallet.writ.test";

const BODY: WritBody = draftToWritBody(
  {
    purpose: "Pottery-themed gift for my sister",
    constraints: {
      total_minor: "6000",
      require_human_above_minor: "4000",
      categories: ["arts_crafts.pottery_ceramics", "home_kitchen.drinkware"],
      deliver_by: "2026-11-20",
    },
    clarifying_questions: [],
    assumptions: [],
  },
  {
    writ_id: "wr_01m6gvezy0dr1r16bxj90g7evg",
    user_id: "usr_01m4xbgky0sz7a9g9yq0gp0b0q",
    agent_id: "agt_01m6bpnhy0gamhs3rbkgbgz6jz",
    ship_to: { ref: "adr_01m4zxxay0px37k8h9k4b9zy5q", label: "Home (Austin)" },
    now: new Date("2026-11-03T14:02:00.000Z"),
  },
);
const HASH = writHash(BODY);
const EDITED: WritBody = { ...BODY, limits: { ...BODY.limits, total_minor: "60000" } };

interface Passkey {
  privateKey: KeyObject;
  credential: PasskeyCredential;
}

/** A real P-256 passkey: COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}. */
function makePasskey(counter = 0): Passkey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = fromBase64Url(jwk.x as string);
  const y = fromBase64Url(jwk.y as string);
  const publicKeyCose = concatBytes(
    Uint8Array.of(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20),
    x,
    Uint8Array.of(0x22, 0x58, 0x20),
    y,
  );
  return { privateKey, credential: { id: toBase64Url(new Uint8Array(randomBytes(16))), publicKeyCose, counter } };
}

interface AssertionOptions {
  hash?: Uint8Array;
  origin?: string;
  rpId?: string;
  type?: string;
  flags?: number;
  counter?: number;
  extraClientData?: Record<string, unknown>;
}

const UP = 0x01;
const UV = 0x04;

/** What a browser authenticator returns for navigator.credentials.get({challenge: hash}). */
function assertWith(passkey: Passkey, options: AssertionOptions = {}): WebAuthnSignature {
  const clientData = {
    type: options.type ?? "webauthn.get",
    challenge: toBase64Url(options.hash ?? HASH),
    origin: options.origin ?? ORIGIN,
    crossOrigin: false,
    ...options.extraClientData,
  };
  const clientDataJson = utf8(JSON.stringify(clientData));
  const counter = new Uint8Array(4);
  new DataView(counter.buffer).setUint32(0, options.counter ?? 1, false);
  const authData = concatBytes(sha256(options.rpId ?? RP_ID), Uint8Array.of(options.flags ?? UP | UV), counter);
  const signature = nodeSign("sha256", concatBytes(authData, sha256(clientDataJson)), passkey.privateKey);
  return {
    kind: "webauthn",
    credential_id: passkey.credential.id,
    authenticator_data: toBase64Url(authData),
    client_data_json: toBase64Url(clientDataJson),
    signature: toBase64Url(new Uint8Array(signature)),
    user_handle: null,
  };
}

function input(passkey: Passkey, signature: WebAuthnSignature, overrides: Partial<WebAuthnOverHashInput> = {}): WebAuthnOverHashInput {
  return {
    hash: HASH,
    signature,
    credential: passkey.credential,
    expectedOrigin: ORIGIN,
    expectedRpId: RP_ID,
    requireUserVerification: true,
    ...overrides,
  };
}

function webauthnCtx(passkey: Passkey) {
  return { webauthn: { credential: passkey.credential, expectedOrigin: ORIGIN, expectedRpId: RP_ID, requireUserVerification: true } };
}

function flipLastByte(text: string): string {
  const bytes = fromBase64Url(text);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0x01;
  return toBase64Url(bytes);
}

describe("verifyWritSignature with a passkey", () => {
  const passkey = makePasskey();

  it("accepts an assertion over the Writ hash", async () => {
    const result = await verifyWritSignature(BODY, assertWith(passkey), webauthnCtx(passkey));
    expect(result).toEqual({ ok: true, kind: "webauthn", writHash: HASH, newCounter: 1, userVerified: true });
  });

  it("rejects the same assertion for an edited Writ body", async () => {
    const result = await verifyWritSignature(EDITED, assertWith(passkey), webauthnCtx(passkey));
    expect(result).toMatchObject({ ok: false, reason: "challenge_mismatch" });
    const unlocked = { ...BODY, ship_to: { ...BODY.ship_to, locked: false } };
    expect(await verifyWritSignature(unlocked, assertWith(passkey), webauthnCtx(passkey))).toMatchObject({
      ok: false,
      reason: "challenge_mismatch",
    });
  });

  it("fails closed on an invalid body, a malformed signature or missing verification material", async () => {
    const signature = assertWith(passkey);
    expect(await verifyWritSignature({ ...BODY, purpose: "" }, signature, webauthnCtx(passkey))).toMatchObject({
      reason: "invalid_body",
    });
    const withExtra = { ...signature, payee: "x" } as unknown as WebAuthnSignature;
    expect(await verifyWritSignature(BODY, withExtra, webauthnCtx(passkey))).toMatchObject({ reason: "malformed" });
    expect(await verifyWritSignature(BODY, signature, {})).toMatchObject({ reason: "no_verifier" });
    expect(await verifyWritSignature(BODY, signature, { deviceKeys: [new Uint8Array(32)] })).toMatchObject({
      reason: "no_verifier",
    });
  });
});

describe("verifyWebAuthnOverHash", () => {
  const passkey = makePasskey();

  it("accepts a valid assertion and reports the new counter", async () => {
    const result = await verifyWebAuthnOverHash(input(passkey, assertWith(passkey, { counter: 7 })));
    expect(result).toEqual({ ok: true, newCounter: 7, userVerified: true });
  });

  it("accepts any of several expected origins", async () => {
    const result = await verifyWebAuthnOverHash(
      input(passkey, assertWith(passkey), { expectedOrigin: ["https://console.writ.test", ORIGIN] }),
    );
    expect(result.ok).toBe(true);
  });

  it.each<[string, () => WebAuthnSignature, string]>([
    ["a flipped signature byte", () => ({ ...assertWith(passkey), signature: flipLastByte(assertWith(passkey).signature) }), "bad_signature"],
    [
      "clientDataJSON edited after signing",
      () => {
        const sig = assertWith(passkey);
        const clientData = JSON.parse(new TextDecoder().decode(fromBase64Url(sig.client_data_json))) as Record<string, unknown>;
        return { ...sig, client_data_json: toBase64Url(utf8(JSON.stringify({ ...clientData, note: "edited" }))) };
      },
      "bad_signature",
    ],
    [
      "authenticatorData edited after signing",
      () => {
        const sig = assertWith(passkey);
        return { ...sig, authenticator_data: flipLastByte(sig.authenticator_data) };
      },
      "bad_signature",
    ],
    ["a signature from another key", () => ({ ...assertWith(makePasskey()), credential_id: passkey.credential.id }), "bad_signature"],
    ["a wrong origin", () => assertWith(passkey, { origin: "https://deals-outlet.test" }), "origin_mismatch"],
    ["a wrong RP ID", () => assertWith(passkey, { rpId: "deals-outlet.test" }), "rp_id_mismatch"],
    ["a different challenge", () => assertWith(passkey, { hash: sha256("another document") }), "challenge_mismatch"],
    ["a registration-type response", () => assertWith(passkey, { type: "webauthn.create" }), "type_mismatch"],
    ["a cross-origin iframe", () => assertWith(passkey, { extraClientData: { crossOrigin: true } }), "cross_origin"],
    ["no user presence", () => assertWith(passkey, { flags: UV }), "user_not_present"],
    ["no user verification when required", () => assertWith(passkey, { flags: UP }), "user_not_verified"],
    ["another credential's assertion", () => assertWith(makePasskey()), "credential_mismatch"],
  ])("rejects %s", async (_name, makeSignature, reason) => {
    const result = await verifyWebAuthnOverHash(input(passkey, makeSignature()));
    expect(result).toMatchObject({ ok: false, reason });
  });

  it("allows a missing UV flag only when verification is not required", async () => {
    const result = await verifyWebAuthnOverHash(
      input(passkey, assertWith(passkey, { flags: UP }), { requireUserVerification: false }),
    );
    expect(result).toEqual({ ok: true, newCounter: 1, userVerified: false });
  });

  it("re-verifies a stored assertion without the counter check, but never a bad signature", async () => {
    const stored = { ...passkey, credential: { ...passkey.credential, counter: 5 } };
    const assertion = assertWith(stored, { counter: 5 });
    expect(await verifyWebAuthnOverHash({ ...input(stored, assertion), skipCounterCheck: true })).toMatchObject({ ok: true });
    const forged = { ...assertion, signature: assertWith(stored, { counter: 5, hash: new Uint8Array(32) }).signature };
    expect(await verifyWebAuthnOverHash({ ...input(stored, forged), skipCounterCheck: true })).toMatchObject({ ok: false });
  });

  it("rejects a counter that does not advance and allows always-zero authenticators", async () => {
    const stored = { ...passkey, credential: { ...passkey.credential, counter: 5 } };
    expect(await verifyWebAuthnOverHash(input(stored, assertWith(stored, { counter: 5 })))).toMatchObject({
      reason: "counter_replay",
    });
    expect(await verifyWebAuthnOverHash(input(stored, assertWith(stored, { counter: 0 })))).toMatchObject({
      reason: "counter_replay",
    });
    expect(await verifyWebAuthnOverHash(input(stored, assertWith(stored, { counter: 6 })))).toMatchObject({
      ok: true,
      newCounter: 6,
    });
    expect(await verifyWebAuthnOverHash(input(passkey, assertWith(passkey, { counter: 0 })))).toMatchObject({
      ok: true,
      newCounter: 0,
    });
  });

  it("never throws on malformed input", async () => {
    const sig = assertWith(passkey);
    const cases: [WebAuthnOverHashInput, string][] = [
      [input(passkey, sig, { hash: HASH.slice(0, 31) }), "malformed"],
      [input(passkey, { ...sig, client_data_json: toBase64Url(utf8("not json")) }), "malformed"],
      [input(passkey, { ...sig, client_data_json: toBase64Url(utf8('{"type":"webauthn.get"}')) }), "malformed"],
      [input(passkey, { ...sig, authenticator_data: toBase64Url(new Uint8Array(10)) }), "malformed"],
      [input(passkey, { ...sig, signature: `${sig.signature}=` }), "malformed"],
      [input(passkey, { ...sig, user_handle: "" }), "malformed"],
      [input(passkey, sig, { credential: { ...passkey.credential, counter: -1 } }), "malformed"],
      [input(passkey, sig, { credential: { ...passkey.credential, publicKeyCose: Uint8Array.of(1, 2, 3) } }), "assertion_rejected"],
      [input(passkey, { ...sig, signature: toBase64Url(Uint8Array.of(0x30, 0x02, 0x00)) }), "assertion_rejected"],
    ];
    for (const [badInput, reason] of cases) {
      await expect(verifyWebAuthnOverHash(badInput)).resolves.toMatchObject({ ok: false, reason });
    }
  });

  it("passes a user handle through", async () => {
    const sig = { ...assertWith(passkey), user_handle: toBase64Url(utf8("usr_01m4xbgky0sz7a9g9yq0gp0b0q")) };
    expect((await verifyWebAuthnOverHash(input(passkey, sig))).ok).toBe(true);
  });
});

describe("Ed25519 device-key fallback", () => {
  const device = generateDeviceKeyEd25519();
  const other = generateDeviceKeyEd25519();

  it("signs the domain-separated message and verifies", () => {
    expect(deviceSignatureMessage(HASH)).toEqual(concatBytes(utf8(DEVICE_SIGNATURE_DOMAIN), HASH));
    const signature = signDeviceEd25519(HASH, device.secretKey);
    expect(WritSignatureSchema.parse(signature)).toEqual(signature);
    expect(fromBase64Url(signature.public_key)).toEqual(device.publicKey);
    expect(verifyDeviceEd25519(HASH, signature, [device.publicKey])).toEqual({ ok: true });
  });

  it("verifies through verifyWritSignature against registered keys", async () => {
    const signature = signDeviceEd25519(HASH, device.secretKey);
    expect(await verifyWritSignature(BODY, signature, { deviceKeys: [other.publicKey, device.publicKey] })).toEqual({
      ok: true,
      kind: "device-ed25519",
      writHash: HASH,
      newCounter: null,
      userVerified: false,
    });
    expect(await verifyWritSignature(EDITED, signature, { deviceKeys: [device.publicKey] })).toMatchObject({
      reason: "bad_signature",
    });
    expect(await verifyWritSignature(BODY, signature, {})).toMatchObject({ reason: "no_verifier" });
  });

  it("rejects a tampered hash", () => {
    const signature = signDeviceEd25519(HASH, device.secretKey);
    const tampered = Uint8Array.from(HASH);
    tampered[0] = (tampered[0] as number) ^ 0x80;
    expect(verifyDeviceEd25519(tampered, signature, [device.publicKey])).toMatchObject({ reason: "bad_signature" });
  });

  it("rejects a wrong or unregistered key", () => {
    const signature = signDeviceEd25519(HASH, other.secretKey);
    expect(verifyDeviceEd25519(HASH, signature, [device.publicKey])).toMatchObject({ reason: "unknown_device_key" });
    const relabeled: DeviceEd25519Signature = { ...signature, public_key: toBase64Url(device.publicKey) };
    expect(verifyDeviceEd25519(HASH, relabeled, [device.publicKey])).toMatchObject({ reason: "bad_signature" });
  });

  it("rejects a signature over the bare hash (no domain separation)", () => {
    const bare: DeviceEd25519Signature = {
      kind: "device-ed25519",
      public_key: toBase64Url(device.publicKey),
      signature: toBase64Url(ed25519.sign(HASH, device.secretKey)),
    };
    expect(verifyDeviceEd25519(HASH, bare, [device.publicKey])).toMatchObject({ reason: "bad_signature" });
  });

  it("rejects malformed signatures without throwing", () => {
    const signature = signDeviceEd25519(HASH, device.secretKey);
    expect(verifyDeviceEd25519(HASH.slice(1), signature, [device.publicKey])).toMatchObject({ reason: "malformed" });
    expect(verifyDeviceEd25519(HASH, { ...signature, signature: signature.signature.slice(1) }, [device.publicKey])).toMatchObject({
      reason: "malformed",
    });
    expect(() => deviceSignatureMessage(new Uint8Array(31))).toThrow(RangeError);
  });
});

describe("WritSignatureSchema", () => {
  const device = signDeviceEd25519(HASH, generateDeviceKeyEd25519().secretKey);

  it("discriminates on kind and rejects unknown kinds or fields", () => {
    expect(WritSignatureSchema.safeParse({ ...device, kind: "rsa" }).success).toBe(false);
    expect(WritSignatureSchema.safeParse({ ...device, key_id: "k1" }).success).toBe(false);
    expect(WritSignatureSchema.safeParse(assertWith(makePasskey())).success).toBe(true);
  });

  it("requires exact Ed25519 lengths and canonical base64url", () => {
    expect(WritSignatureSchema.safeParse({ ...device, public_key: toBase64Url(new Uint8Array(33)) }).success).toBe(false);
    expect(WritSignatureSchema.safeParse({ ...device, signature: toBase64Url(new Uint8Array(63)) }).success).toBe(false);
    // 32 bytes = 43 chars whose last char carries 2 zero padding bits. Setting one of those bits gives
    // a second spelling a lenient decoder maps to the same key; only one spelling may be stored.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastIndex = alphabet.indexOf(device.public_key.slice(-1));
    expect(lastIndex % 4).toBe(0);
    const nonCanonical = `${device.public_key.slice(0, 42)}${alphabet.charAt(lastIndex + 1)}`;
    expect(fromBase64Url(nonCanonical)).toEqual(fromBase64Url(device.public_key));
    expect(WritSignatureSchema.safeParse({ ...device, public_key: nonCanonical }).success).toBe(false);
    expect(WritSignatureSchema.safeParse({ ...device, public_key: `${device.public_key}=` }).success).toBe(false);
  });

  it("requires explicit null for a missing user handle", () => {
    const { user_handle: _drop, ...withoutHandle } = assertWith(makePasskey());
    expect(WritSignatureSchema.safeParse(withoutHandle).success).toBe(false);
  });
});
