// Agents & keys in the Wallet (P0-3; owner: api stream; routes in apps/gateway/src/routes/agents.ts).
// An agent key is shown once and stored as sha256 (agents.api_key_hash). Every wallet gets one
// built-in Atlas and one built-in Scout at creation; they hold keys like any external agent.
import { z } from "zod";
import { idSchema } from "../ids";
import { singleLineText } from "../writ";
import { TimestampSchema } from "./common";

export const AGENT_KINDS = ["builtin", "mcp", "sdk"] as const;
export const AgentKindSchema = z.enum(AGENT_KINDS);
export type AgentKind = z.infer<typeof AgentKindSchema>;

/** The reference agents (plan §8.3): Atlas is deliberately naive, Scout is hardened. */
export const BUILTIN_AGENT_KINDS = ["atlas", "scout"] as const;
export const BuiltinAgentKindSchema = z.enum(BUILTIN_AGENT_KINDS);
export type BuiltinAgentKind = z.infer<typeof BuiltinAgentKindSchema>;

/** "wak_" + base64url(32 random bytes). */
export const AGENT_KEY_PREFIX = "wak_";
export const AgentKeySchema = z.string().regex(/^wak_[A-Za-z0-9_-]{43}$/, "expected a Writ agent key");

export const AgentViewSchema = z.strictObject({
  agent_id: idSchema("agt"),
  name: singleLineText(60),
  kind: AgentKindSchema,
  builtin_kind: BuiltinAgentKindSchema.nullable(),
  /** Last 4 characters of the current key, for recognition only. */
  key_hint: z.string().max(8),
  created_at: TimestampSchema,
  last_used_at: TimestampSchema.nullable(),
  revoked_at: TimestampSchema.nullable(),
});
export type AgentView = z.infer<typeof AgentViewSchema>;

// POST /v1/agents
export const CreateAgentRequestSchema = z.strictObject({
  name: singleLineText(60),
  kind: z.enum(["sdk", "mcp"]),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;
export const CreateAgentResponseSchema = z.strictObject({
  agent: AgentViewSchema,
  /** Shown once; only its sha256 is stored. */
  api_key: AgentKeySchema,
});
export type CreateAgentResponse = z.infer<typeof CreateAgentResponseSchema>;

// GET /v1/agents
export const ListAgentsResponseSchema = z.strictObject({ agents: z.array(AgentViewSchema).max(200) });
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;
