"use client";
// Every signature is made here, on this origin (plan §6.6). A passkey signs when the account has one. The
// labeled fallback is an Ed25519 device key in WebCrypto: non-extractable, kept in IndexedDB, so page code
// can use it but never read it.
import { deviceSignatureMessage, fromBase64Url, toBase64Url, type WritSignature } from "@writ/core";
import type { WebAuthnRequestOptions } from "@writ/core/api";
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

const DB = "writ-device-key";
const STORE = "keys";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open device key storage."));
  });
}

async function readKey(): Promise<CryptoKeyPair | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const get = db.transaction(STORE).objectStore(STORE).get("device");
    get.onsuccess = () => resolve((get.result as CryptoKeyPair | undefined) ?? null);
    get.onerror = () => reject(get.error ?? new Error("Could not read the device key."));
  });
}

async function writeKey(pair: CryptoKeyPair): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(pair, "device");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not save the device key."));
  });
}

async function publicKeyOf(pair: CryptoKeyPair): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
}

/** Creates this browser's device key (or reuses it) and returns the raw public key. */
export async function ensureDeviceKey(): Promise<string> {
  const existing = await readKey();
  if (existing !== null) return publicKeyOf(existing);
  let pair: CryptoKeyPair;
  try {
    pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  } catch {
    throw new Error("This browser does not support device keys. Use a passkey or a newer browser.");
  }
  await writeKey(pair);
  return publicKeyOf(pair);
}

async function signWithDeviceKey(challenge: string): Promise<WritSignature> {
  const pair = await readKey();
  if (pair === null) throw new Error("This browser has no device key for this account.");
  const message = deviceSignatureMessage(fromBase64Url(challenge));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message as BufferSource));
  return { kind: "device-ed25519", public_key: await publicKeyOf(pair), signature: toBase64Url(signature) } as WritSignature;
}

async function signWithPasskey(options: WebAuthnRequestOptions): Promise<WritSignature> {
  const response = await startAuthentication({ optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON });
  return {
    kind: "webauthn",
    credential_id: response.id,
    authenticator_data: response.response.authenticatorData,
    client_data_json: response.response.clientDataJSON,
    signature: response.response.signature,
    user_handle: response.response.userHandle ?? null,
  } as WritSignature;
}

/** The gateway decides which: it sends passkey options only for an account that has a passkey. */
export function signChallenge(challenge: string, options: WebAuthnRequestOptions | null): Promise<WritSignature> {
  return options === null ? signWithDeviceKey(challenge) : signWithPasskey(options);
}
