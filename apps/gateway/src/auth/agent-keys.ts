// Agent API keys (plan §6.5 agents.api_key_hash, threat T10). Format "wak_" + base64url(32 random
// bytes); only sha256(key) is stored, the key is shown once. Built-in agents get a fresh key at the
// start of each run (the runner keeps it in memory), so they cross the same trust boundary as any
// external agent (plan decision 6).
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md).
import { randomBytes } from "node:crypto";
import { sha256, toBase64Url } from "@writ/core";
import { AGENT_KEY_PREFIX, AgentKeySchema, type AgentKind, type BuiltinAgentKind } from "@writ/core/api";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { agents } from "../db/schema";

export interface MintedAgentKey {
  /** Show once; never log or store it. */
  key: string;
  /** sha256(key), for agents.api_key_hash. */
  hash: Uint8Array;
  /** Last 4 characters, for agents.key_hint. */
  hint: string;
}

export function mintAgentKey(): MintedAgentKey {
  const key = `${AGENT_KEY_PREFIX}${toBase64Url(new Uint8Array(randomBytes(32)))}`;
  return { key, hash: hashAgentKey(key), hint: key.slice(-4) };
}

export function hashAgentKey(key: string): Uint8Array {
  return sha256(key);
}

/** The key from an `Authorization: Bearer wak_...` header, or null. */
export function parseBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (match === null) return null;
  const key = match[1] as string;
  return AgentKeySchema.safeParse(key).success ? key : null;
}

/** The authenticated caller of the agent API. Tenant and user come from the key's row, never from the request. */
export interface AgentPrincipal {
  readonly agentId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly kind: AgentKind;
  readonly builtinKind: BuiltinAgentKind | null;
}

/** Looks the key up by hash; revoked agents do not authenticate. */
export async function findAgentByKey(db: Db, key: string): Promise<AgentPrincipal | null> {
  const [row] = await db
    .select({ id: agents.id, tenantId: agents.tenantId, userId: agents.userId, kind: agents.kind, builtinKind: agents.builtinKind })
    .from(agents)
    .where(and(eq(agents.apiKeyHash, hashAgentKey(key)), isNull(agents.revokedAt)))
    .limit(1);
  if (row === undefined) return null;
  return { agentId: row.id, tenantId: row.tenantId, userId: row.userId, kind: row.kind, builtinKind: row.builtinKind ?? null };
}
