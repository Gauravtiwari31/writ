// Judge mode (P0-13; owner: judge stream; routes in apps/gateway/src/routes/demo.ts). Each visitor
// gets an isolated tenant (cookie) with a seeded Ana, an address book, Atlas and a pre-signed Writ
// signed by a clearly labeled demo device key (plan §18).
import { z } from "zod";
import { idSchema } from "../ids";
import { SessionViewSchema } from "./auth";

// POST /v1/demo/session → Set-Cookie (kind "judge")
export const DemoSessionResponseSchema = z.strictObject({
  session: SessionViewSchema,
  seeded: z.strictObject({ writ_id: idSchema("wr"), agent_id: idSchema("agt"), address_id: idSchema("adr") }),
});
export type DemoSessionResponse = z.infer<typeof DemoSessionResponseSchema>;

// GET /v1/demo/status
export const DemoStatusResponseSchema = z.strictObject({
  judge_mode: z.boolean(),
  hero_runs_per_hour: z.int().min(0),
  /** For the calling tenant; null without a judge session. */
  hero_runs_remaining: z.int().min(0).nullable(),
  llm_calls_remaining_today: z.int().min(0).nullable(),
});
export type DemoStatusResponse = z.infer<typeof DemoStatusResponseSchema>;

// POST /v1/demo/hero-run → 202 RunView (scenes 4-8 via the built-in Atlas), 429 when over the hourly limit.
