// Sessions, passkey registration and sign-in, device keys, address book (P0-1 server side).
// Owner: api stream. Paths and auth are frozen in routes/table.ts; bodies are the named
// @writ/core/api schemas. Every route answers 501 not_implemented until the owner fills it in.
import type { FastifyPluginAsync } from "fastify";
import { notImplemented } from "../http/errors";

const OWNER = "api";

export const authRoutes: FastifyPluginAsync = async (app) => {
  // none → RegisterOptionsResponse
  app.post("/v1/auth/register/options", notImplemented(OWNER, "POST /v1/auth/register/options"));
  // none → SessionView + Set-Cookie
  app.post("/v1/auth/register/verify", notImplemented(OWNER, "POST /v1/auth/register/verify"));
  // none → LoginOptionsResponse
  app.post("/v1/auth/login/options", notImplemented(OWNER, "POST /v1/auth/login/options"));
  // none → SessionView + Set-Cookie
  app.post("/v1/auth/login/verify", notImplemented(OWNER, "POST /v1/auth/login/verify"));
  // session → 204 + cleared cookie
  app.post("/v1/auth/logout", notImplemented(OWNER, "POST /v1/auth/logout"));
  // session → MeResponse
  app.get("/v1/me", notImplemented(OWNER, "GET /v1/me"));
  // session → DeviceKeyView
  app.post("/v1/auth/device-keys", notImplemented(OWNER, "POST /v1/auth/device-keys"));
  // session → AddressListResponse
  app.get("/v1/address-book", notImplemented(OWNER, "GET /v1/address-book"));
  // session → AddressDetail
  app.post("/v1/address-book", notImplemented(OWNER, "POST /v1/address-book"));
};
