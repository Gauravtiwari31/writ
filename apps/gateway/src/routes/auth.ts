// Sessions, passkey registration and sign-in, device keys, address book (P0-1 server side).
import {
  CreateAddressRequestSchema,
  CreateDeviceWalletRequestSchema,
  LoginVerifyRequestSchema,
  RegisterDeviceKeyRequestSchema,
  RegisterOptionsRequestSchema,
  RegisterVerifyRequestSchema,
} from "@writ/core/api";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { sessionOf } from "../auth/guards";
import { addressBook } from "../db/schema";
import { requireDb } from "../deps";
import { parseWith } from "../http/errors";
import { addDeviceKey, addressDetail, createDeviceWallet, loginOptions, loginVerify, me, registerOptions, registerVerify } from "../identity/index";

export const authRoutes: FastifyPluginAsync = async (app) => {
  const services = app.services;

  app.post("/v1/auth/register/options", async (request) => {
    const body = parseWith(RegisterOptionsRequestSchema, request.body);
    return registerOptions(services, body.display_name);
  });

  app.post("/v1/auth/register/verify", async (request, reply) => {
    const body = parseWith(RegisterVerifyRequestSchema, request.body);
    return registerVerify(services, reply, { challengeId: body.challenge_id, response: body.response });
  });

  app.post("/v1/auth/device-wallet", async (request, reply) => {
    const body = parseWith(CreateDeviceWalletRequestSchema, request.body);
    return createDeviceWallet(services, reply, { displayName: body.display_name, publicKey: body.public_key, label: body.label });
  });

  app.post("/v1/auth/login/options", async () => loginOptions(services));

  app.post("/v1/auth/login/verify", async (request, reply) => {
    const body = parseWith(LoginVerifyRequestSchema, request.body);
    return loginVerify(services, reply, { challengeId: body.challenge_id, response: body.response });
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    sessionOf(request);
    services.sessions.clear(reply);
    return reply.code(204).send();
  });

  app.get("/v1/me", async (request) => me(requireDb(services), sessionOf(request)));

  app.post("/v1/auth/device-keys", async (request) => {
    const session = sessionOf(request);
    const body = parseWith(RegisterDeviceKeyRequestSchema, request.body);
    return addDeviceKey(services, session, { publicKey: body.public_key, label: body.label });
  });

  app.get("/v1/address-book", async (request) => {
    const session = sessionOf(request);
    const rows = await requireDb(services).select().from(addressBook).where(eq(addressBook.userId, session.userId));
    return { addresses: rows.map(addressDetail) };
  });

  app.post("/v1/address-book", async (request) => {
    const session = sessionOf(request);
    const body = parseWith(CreateAddressRequestSchema, request.body);
    const [row] = await requireDb(services)
      .insert(addressBook)
      .values({ id: services.ids("address"), tenantId: session.tenantId, userId: session.userId, ...body })
      .returning();
    if (row === undefined) throw new Error("address insert returned no row");
    return addressDetail(row);
  });
};
