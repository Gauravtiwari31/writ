// Judge mode (P0-13): one click makes an isolated tenant; the hero run is rate limited per tenant and on the
// global daily model budget. The run itself is a real Atlas run: no keys means a visible failure, never a fake.
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { judgeSessionOf } from "../auth/guards";
import { writs } from "../db/schema";
import { requireDb } from "../deps";
import { httpError } from "../http/errors";
import { sessionView } from "../identity/index";
import { seedJudgeTenant } from "../judge/index";

export const demoRoutes: FastifyPluginAsync = async (app) => {
  const services = app.services;

  // Per IP, because a session does not exist yet: minting tenants is the unauthenticated surface here.
  app.post("/v1/demo/session", { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (_request, reply) => {
    if (!services.config.judge.enabled) throw httpError.notFound("Judge mode");
    const seeded = await seedJudgeTenant(services);
    const claims = services.sessions.issue(reply, { userId: seeded.userId, tenantId: seeded.tenantId, kind: "judge" });
    return {
      session: sessionView(claims, { id: seeded.userId, displayName: "Ana (demo)", demo: true }),
      seeded: { writ_id: seeded.writId, agent_id: seeded.atlasId, address_id: seeded.addressId },
    };
  });

  app.get("/v1/demo/status", async (request) => {
    const session = request.session;
    return {
      judge_mode: services.config.judge.enabled,
      hero_runs_per_hour: services.config.judge.heroRunsPerHour,
      hero_runs_remaining: session === null ? null : await services.limits.heroRunsRemaining(session.tenantId),
      llm_calls_remaining_today: await services.limits.llmCallsRemaining(),
    };
  });

  app.post("/v1/demo/hero-run", async (request, reply) => {
    const session = judgeSessionOf(request);
    const budget = await services.limits.tryConsumeHeroRun(session.tenantId);
    if (!budget.allowed) throw httpError.tooManyRequests("You have used this hour's hero runs. Try again later.");
    const [writ] = await requireDb(services)
      .select({ id: writs.id })
      .from(writs)
      .where(and(eq(writs.tenantId, session.tenantId), eq(writs.status, "ACTIVE")))
      .limit(1);
    if (writ === undefined) throw httpError.conflict("writ_not_active", "The demo Writ is no longer active. Start a new judge session.");
    const run = await services.runs.start({ tenantId: session.tenantId, userId: session.userId, agentKind: "atlas", writId: writ.id, mode: "hero" });
    return reply.code(202).send(run);
  });
};
