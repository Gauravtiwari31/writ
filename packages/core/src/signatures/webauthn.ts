// Passkey signature over an arbitrary 32-byte hash: the hash is the WebAuthn challenge, so the
// assertion binds the user's gesture to exactly one document (a Writ, or a P0-6 approval).
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";
import { equalBytes, fromBase64Url, toBase64Url } from "../bytes";
import { HASH_BYTES, sha256 } from "../hash";
import { errorDetail, signatureFailure, WebAuthnSignatureSchema, type SignatureFailure, type WebAuthnSignature } from "./schema";

/** A row of plan §6.5 `passkeys`, belonging to the principal whose document is being verified. */
export interface PasskeyCredential {
  /** base64url credential id. */
  id: string;
  publicKeyCose: Uint8Array;
  counter: number;
}

export interface WebAuthnOverHashInput {
  hash: Uint8Array;
  signature: WebAuthnSignature;
  credential: PasskeyCredential;
  expectedOrigin: string | readonly string[];
  expectedRpId: string;
  requireUserVerification: boolean;
  /** Only for re-verifying a stored assertion (verifyStoredWritSignature); live ceremonies keep the replay check. */
  skipCounterCheck?: boolean;
}

/** On success, persist `newCounter` to passkeys.counter so a replayed assertion fails next time. */
export type WebAuthnVerification = { ok: true; newCounter: number; userVerified: boolean } | SignatureFailure;

const ClientDataSchema = z.looseObject({
  type: z.string(),
  challenge: z.string(),
  origin: z.string(),
  crossOrigin: z.boolean().optional(),
  topOrigin: z.string().optional(),
});

const RP_ID_HASH_BYTES = 32;
const AUTH_DATA_MIN_BYTES = RP_ID_HASH_BYTES + 1 + 4;
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Verifies a passkey assertion whose challenge is base64url(hash). Never throws: every failure is
 * `{ok: false, reason}`. The cheap checks below exist to name the failure precisely;
 * @simplewebauthn/server then re-checks everything and verifies the signature.
 */
export async function verifyWebAuthnOverHash(input: WebAuthnOverHashInput): Promise<WebAuthnVerification> {
  try {
    return await verify(input);
  } catch (error) {
    return signatureFailure("assertion_rejected", errorDetail(error));
  }
}

async function verify(input: WebAuthnOverHashInput): Promise<WebAuthnVerification> {
  const { hash, credential, expectedRpId, requireUserVerification } = input;
  if (!(hash instanceof Uint8Array) || hash.length !== HASH_BYTES) {
    return signatureFailure("malformed", `hash must be ${HASH_BYTES} bytes`);
  }
  if (!Number.isSafeInteger(credential.counter) || credential.counter < 0) {
    return signatureFailure("malformed", "stored credential counter must be a non-negative integer");
  }
  const parsed = WebAuthnSignatureSchema.safeParse(input.signature);
  if (!parsed.success) return signatureFailure("malformed", "signature does not match WebAuthnSignatureSchema");
  const sig = parsed.data;
  // The library trusts the caller to have looked the credential up by this id; check it anyway.
  if (sig.credential_id !== credential.id) {
    return signatureFailure("credential_mismatch", "assertion was made with a different credential");
  }

  const challenge = toBase64Url(hash);
  const origins = typeof input.expectedOrigin === "string" ? [input.expectedOrigin] : [...input.expectedOrigin];

  let clientData: z.infer<typeof ClientDataSchema>;
  try {
    clientData = ClientDataSchema.parse(JSON.parse(utf8Decoder.decode(fromBase64Url(sig.client_data_json))));
  } catch {
    return signatureFailure("malformed", "clientDataJSON is not a valid client data object");
  }
  if (clientData.type !== "webauthn.get") {
    return signatureFailure("type_mismatch", `clientDataJSON.type is ${JSON.stringify(clientData.type)}`);
  }
  if (clientData.challenge !== challenge) {
    return signatureFailure("challenge_mismatch", "assertion was made over a different hash");
  }
  if (!origins.includes(clientData.origin)) {
    return signatureFailure("origin_mismatch", `unexpected origin ${JSON.stringify(clientData.origin)}`);
  }
  if (clientData.crossOrigin === true || clientData.topOrigin !== undefined) {
    return signatureFailure("cross_origin", "assertion was made inside a cross-origin frame");
  }

  const authData = fromBase64Url(sig.authenticator_data);
  if (authData.length < AUTH_DATA_MIN_BYTES) return signatureFailure("malformed", "authenticatorData is too short");
  if (!equalBytes(authData.subarray(0, RP_ID_HASH_BYTES), sha256(expectedRpId))) {
    return signatureFailure("rp_id_mismatch", "authenticatorData was produced for a different RP ID");
  }
  const flags = authData[RP_ID_HASH_BYTES] as number;
  if ((flags & FLAG_USER_PRESENT) === 0) return signatureFailure("user_not_present", "UP flag is not set");
  if (requireUserVerification && (flags & FLAG_USER_VERIFIED) === 0) {
    return signatureFailure("user_not_verified", "UV flag is not set but user verification is required");
  }
  const counter = new DataView(authData.buffer, authData.byteOffset + RP_ID_HASH_BYTES + 1, 4).getUint32(0, false);
  // Same rule as the library: authenticators that always report 0 (many synced passkeys) are allowed.
  const storedCounter = input.skipCounterCheck === true ? 0 : credential.counter;
  if ((counter > 0 || storedCounter > 0) && counter <= storedCounter) {
    return signatureFailure("counter_replay", `counter ${counter} did not advance past ${storedCounter}`);
  }

  const response: AuthenticationResponseJSON = {
    id: sig.credential_id,
    rawId: sig.credential_id,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: sig.client_data_json,
      authenticatorData: sig.authenticator_data,
      signature: sig.signature,
      ...(sig.user_handle === null ? {} : { userHandle: sig.user_handle }),
    },
  };
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origins,
    expectedRPID: expectedRpId,
    expectedType: "webauthn.get",
    credential: { id: credential.id, publicKey: Uint8Array.from(credential.publicKeyCose), counter: storedCounter },
    requireUserVerification,
  });
  if (!result.verified) {
    return signatureFailure("bad_signature", "signature does not verify against the registered public key");
  }
  return {
    ok: true,
    newCounter: result.authenticationInfo.newCounter,
    userVerified: result.authenticationInfo.userVerified,
  };
}
