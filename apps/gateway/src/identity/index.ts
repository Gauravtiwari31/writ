// Wallets, passkeys and device keys (P0-1 server side). Every WebAuthn ceremony runs in the Wallet on
// APP_BASE_URL; the gateway only verifies (plan §6.6). A wallet is one user in its own tenant, with one
// built-in Atlas and one built-in Scout. Device keys are the labeled fallback signer (S6): a user who
// has a passkey cannot add one, so a stolen session never becomes a signature.
import { fromBase64Url, toBase64Url } from "@writ/core";
import type { AddressDetail, AgentView, DeviceKeyView, MeResponse, SessionView } from "@writ/core/api";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import { mintAgentKey } from "../auth/agent-keys";
import type { SessionClaims } from "../auth/session";
import { SYSTEM_TENANT } from "../db/enums";
import type { Db } from "../db/client";
import { addressBook, agents, authChallenges, deviceKeys, passkeys, users, type Agent } from "../db/schema";
import { requireDb, type CoreServices } from "../deps";
import { httpError } from "../http/errors";
import type { TxContext } from "../tx/unit-of-work";

const CHALLENGE_TTL_MS = 5 * 60_000;

export interface NewWallet {
  readonly tenantId: string;
  readonly userId: string;
  readonly atlasId: string;
  readonly scoutId: string;
}

/** Inside the caller's transaction: the user plus its built-in agents, whose keys are re-minted at each run. */
export async function createWalletRows(deps: Pick<CoreServices, "ids">, ctx: TxContext, input: { userId: string; displayName: string; demo?: boolean }): Promise<NewWallet> {
  await ctx.db.insert(users).values({ id: input.userId, tenantId: ctx.tenantId, displayName: input.displayName, demo: input.demo ?? false, createdAt: ctx.now });
  const insertAgent = async (name: string, builtinKind: "atlas" | "scout"): Promise<string> => {
    const id = deps.ids("agent");
    const minted = mintAgentKey();
    await ctx.db.insert(agents).values({
      id,
      tenantId: ctx.tenantId,
      userId: input.userId,
      name,
      kind: "builtin",
      builtinKind,
      apiKeyHash: minted.hash,
      keyHint: minted.hint,
      createdAt: ctx.now,
    });
    return id;
  };
  const atlasId = await insertAgent("Atlas (untrusted demo agent)", "atlas");
  const scoutId = await insertAgent("Scout (hardened demo agent)", "scout");
  return { tenantId: ctx.tenantId, userId: input.userId, atlasId, scoutId };
}

export function agentView(row: Agent): AgentView {
  return {
    agent_id: row.id as AgentView["agent_id"],
    name: row.name,
    kind: row.kind,
    builtin_kind: row.builtinKind ?? null,
    key_hint: row.keyHint,
    created_at: row.createdAt.toISOString(),
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
  };
}

export function sessionView(claims: SessionClaims, user: { id: string; displayName: string; demo: boolean }): SessionView {
  return {
    user: { user_id: user.id as SessionView["user"]["user_id"], display_name: user.displayName, demo: user.demo },
    tenant_id: claims.tenantId,
    kind: claims.kind,
    expires_at: new Date(claims.expiresAt * 1000).toISOString(),
  };
}

function requireWebAuthn(deps: Pick<CoreServices, "config">) {
  const webauthn = deps.config.webauthn;
  if (webauthn === null) throw httpError.unavailable("webauthn_unconfigured", deps.config.webauthnProblem ?? "Passkeys are not configured on this gateway.");
  return webauthn;
}

async function takeChallenge(deps: CoreServices, challengeId: string, purpose: "register" | "login") {
  const db = requireDb(deps);
  const now = deps.clock();
  const [row] = await db
    .update(authChallenges)
    .set({ consumedAt: now })
    .where(and(eq(authChallenges.id, challengeId), eq(authChallenges.purpose, purpose), isNull(authChallenges.consumedAt)))
    .returning();
  if (row === undefined) throw httpError.badRequest("challenge_invalid", "This sign-in attempt is no longer valid. Start again.");
  if (row.expiresAt.getTime() <= now.getTime()) throw httpError.badRequest("challenge_expired", "This sign-in attempt expired. Start again.");
  return row;
}

export async function registerOptions(deps: CoreServices, displayName: string) {
  const webauthn = requireWebAuthn(deps);
  const db = requireDb(deps);
  const now = deps.clock();
  const challenge = new Uint8Array(randomBytes(32));
  const userId = deps.ids("user");
  const tenantId = deps.ids("tenant");
  const options = await generateRegistrationOptions({
    rpName: webauthn.rpName,
    rpID: webauthn.rpId,
    userName: displayName,
    userID: new TextEncoder().encode(userId),
    challenge,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const id = deps.ids("challenge");
  await db.insert(authChallenges).values({
    id,
    tenantId: SYSTEM_TENANT,
    userId,
    purpose: "register",
    challenge,
    context: { display_name: displayName, tenant_id: tenantId },
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
  });
  return { challenge_id: id, options };
}

export async function registerVerify(deps: CoreServices, reply: FastifyReply, input: { challengeId: string; response: unknown }): Promise<SessionView> {
  const webauthn = requireWebAuthn(deps);
  const row = await takeChallenge(deps, input.challengeId, "register");
  const context = row.context as { display_name: string; tenant_id: string };
  if (row.userId === null) throw httpError.badRequest("challenge_invalid", "This registration has no pending user.");
  const userId = row.userId;
  let info;
  try {
    const verification = await verifyRegistrationResponse({
      response: input.response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
      expectedChallenge: toBase64Url(row.challenge),
      expectedOrigin: webauthn.origin,
      expectedRPID: webauthn.rpId,
      requireUserVerification: true,
    });
    if (!verification.verified) throw new Error("not verified");
    info = verification.registrationInfo;
  } catch {
    throw httpError.badRequest("passkey_rejected", "The passkey could not be verified.");
  }
  const credential = info.credential;
  await deps.uow.run(context.tenant_id, async (ctx) => {
    await createWalletRows(deps, ctx, { userId, displayName: context.display_name });
    await ctx.db.insert(passkeys).values({
      id: deps.ids("passkey"),
      tenantId: ctx.tenantId,
      userId,
      credentialId: credential.id,
      publicKeyCose: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ?? [],
      backedUp: info.credentialBackedUp,
      createdAt: ctx.now,
    });
  });
  const claims = deps.sessions.issue(reply, { userId, tenantId: context.tenant_id, kind: "user" });
  return sessionView(claims, { id: userId, displayName: context.display_name, demo: false });
}

export async function loginOptions(deps: CoreServices) {
  const webauthn = requireWebAuthn(deps);
  const challenge = new Uint8Array(randomBytes(32));
  const options = await generateAuthenticationOptions({ rpID: webauthn.rpId, challenge, userVerification: "required" });
  const id = deps.ids("challenge");
  await requireDb(deps)
    .insert(authChallenges)
    .values({ id, tenantId: SYSTEM_TENANT, purpose: "login", challenge, expiresAt: new Date(deps.clock().getTime() + CHALLENGE_TTL_MS) });
  return { challenge_id: id, options };
}

export async function loginVerify(deps: CoreServices, reply: FastifyReply, input: { challengeId: string; response: { id: string } }): Promise<SessionView> {
  const webauthn = requireWebAuthn(deps);
  const row = await takeChallenge(deps, input.challengeId, "login");
  const db = requireDb(deps);
  const [passkey] = await db.select().from(passkeys).where(eq(passkeys.credentialId, input.response.id));
  if (passkey === undefined) throw httpError.unauthorized("This passkey is not registered here.");
  let newCounter: number;
  try {
    const verification = await verifyAuthenticationResponse({
      response: input.response as unknown as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge: toBase64Url(row.challenge),
      expectedOrigin: webauthn.origin,
      expectedRPID: webauthn.rpId,
      credential: { id: passkey.credentialId, publicKey: Uint8Array.from(passkey.publicKeyCose), counter: passkey.counter },
      requireUserVerification: true,
    });
    if (!verification.verified) throw new Error("not verified");
    newCounter = verification.authenticationInfo.newCounter;
  } catch {
    throw httpError.unauthorized("The passkey could not be verified.");
  }
  await db.update(passkeys).set({ counter: newCounter, lastUsedAt: deps.clock() }).where(eq(passkeys.id, passkey.id));
  const [user] = await db.select().from(users).where(eq(users.id, passkey.userId));
  if (user === undefined) throw httpError.unauthorized("This passkey has no account.");
  const claims = deps.sessions.issue(reply, { userId: user.id, tenantId: user.tenantId, kind: "user" });
  return sessionView(claims, user);
}

function deviceKeyView(row: typeof deviceKeys.$inferSelect): DeviceKeyView {
  return {
    device_key_id: row.id,
    label: row.label,
    demo: row.demo,
    public_key: toBase64Url(row.publicKeyEd25519),
    created_at: row.createdAt.toISOString(),
  };
}

/** A wallet with no passkey, for browsers without an authenticator (S6 fallback, always labeled "device key"). */
export async function createDeviceWallet(deps: CoreServices, reply: FastifyReply, input: { displayName: string; publicKey: string; label: string }): Promise<SessionView> {
  const userId = deps.ids("user");
  const tenantId = deps.ids("tenant");
  await deps.uow.run(tenantId, async (ctx) => {
    await createWalletRows(deps, ctx, { userId, displayName: input.displayName });
    await ctx.db.insert(deviceKeys).values({ id: deps.ids("deviceKey"), tenantId, userId, publicKeyEd25519: fromBase64Url(input.publicKey), label: input.label, createdAt: ctx.now });
  });
  const claims = deps.sessions.issue(reply, { userId, tenantId, kind: "user" });
  return sessionView(claims, { id: userId, displayName: input.displayName, demo: false });
}

export async function addDeviceKey(deps: CoreServices, claims: SessionClaims, input: { publicKey: string; label: string }): Promise<DeviceKeyView> {
  const db = requireDb(deps);
  const existing = await db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, claims.userId)).limit(1);
  if (existing.length > 0) throw httpError.forbidden("This account has a passkey, so it cannot add a weaker device key.");
  const [row] = await db
    .insert(deviceKeys)
    .values({ id: deps.ids("deviceKey"), tenantId: claims.tenantId, userId: claims.userId, publicKeyEd25519: fromBase64Url(input.publicKey), label: input.label })
    .returning();
  if (row === undefined) throw new Error("device key insert returned no row");
  return deviceKeyView(row);
}

export async function me(db: Db, claims: SessionClaims): Promise<MeResponse> {
  const [user] = await db.select().from(users).where(and(eq(users.id, claims.userId), eq(users.tenantId, claims.tenantId)));
  if (user === undefined) throw httpError.unauthorized();
  const keys = await db.select().from(passkeys).where(eq(passkeys.userId, claims.userId));
  const devices = await db.select().from(deviceKeys).where(and(eq(deviceKeys.userId, claims.userId), isNull(deviceKeys.revokedAt)));
  const addresses = await db.select({ id: addressBook.id, label: addressBook.label }).from(addressBook).where(eq(addressBook.userId, claims.userId));
  return {
    session: sessionView(claims, user),
    passkeys: keys.map((key) => ({
      passkey_id: key.id,
      credential_id: key.credentialId,
      backed_up: key.backedUp,
      created_at: key.createdAt.toISOString(),
      last_used_at: key.lastUsedAt?.toISOString() ?? null,
    })),
    device_keys: devices.map(deviceKeyView),
    addresses: addresses.map((address) => ({ address_id: address.id as MeResponse["addresses"][number]["address_id"], label: address.label })),
  };
}

export function addressDetail(row: typeof addressBook.$inferSelect): AddressDetail {
  return {
    address_id: row.id as AddressDetail["address_id"],
    label: row.label,
    line1: row.line1,
    city: row.city,
    region: row.region,
    postal: row.postal,
    country: row.country,
  };
}
