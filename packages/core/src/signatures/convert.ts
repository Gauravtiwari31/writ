// Browser assertion → stored signature. The Wallet signs with @simplewebauthn/browser, whose
// AuthenticationResponseJSON is already base64url; this keeps exactly the fields Writ verifies and
// stores (writs.signature, approvals.assertion, the evidence pack). Isomorphic and dependency-free.
import { WebAuthnSignatureSchema, type WebAuthnSignature } from "./schema";

/** The subset of @simplewebauthn's AuthenticationResponseJSON that a signature needs. */
export interface AuthenticationResponseLike {
  id: string;
  response: {
    authenticatorData: string;
    clientDataJSON: string;
    signature: string;
    userHandle?: string | null;
  };
}

/** Throws (ZodError) when the response is not a well-formed assertion. */
export function webauthnSignatureFromResponse(response: AuthenticationResponseLike): WebAuthnSignature {
  const userHandle = response.response.userHandle;
  return WebAuthnSignatureSchema.parse({
    kind: "webauthn",
    credential_id: response.id,
    authenticator_data: response.response.authenticatorData,
    client_data_json: response.response.clientDataJSON,
    signature: response.response.signature,
    user_handle: userHandle === undefined || userHandle === null || userHandle === "" ? null : userHandle,
  });
}
