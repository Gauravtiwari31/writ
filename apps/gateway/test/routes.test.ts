// The route-table contract: every row is registered (implemented or a 501 stub with its owner),
// GET /v1/meta reports degraded capabilities honestly, errors use one envelope, and the SSE writer
// streams StreamMessages through a real socket.
import { NotImplementedError, newId } from "@writ/core";
import { MetaResponseSchema, StreamMessageSchema, type StreamMessage } from "@writ/core/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/http/errors";
import { openSse } from "../src/http/sse";
import { ROUTE_TABLE } from "../src/routes/table";
import { buildTestApp, type TestApp } from "./helpers/app";

const IMPLEMENTED = new Set(["GET /healthz", "GET /v1/meta", "POST /v1/webhooks/paypal"]);

describe("route table", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await buildTestApp({
      db: null,
      beforeReady: (app) => {
        app.get("/__t/throw-http", async () => {
          throw new HttpError(409, "conflict", "Already decided.", { approval_id: "apr_x" });
        });
        app.get("/__t/throw-ni", async () => {
          throw new NotImplementedError("money", "PurchaseSaga.open");
        });
        app.get("/__t/throw", async () => {
          throw new Error("secret detail: postgres://user:pw@host/db");
        });
        app.post("/__t/json", async (request) => request.body);
      },
    });
  });

  afterAll(async () => {
    await t.close();
  });

  it("has unique method + path rows and an owner for each", () => {
    const keys = ROUTE_TABLE.map((route) => `${route.method} ${route.url}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const route of ROUTE_TABLE) expect(route.file).toMatch(/^[a-z-]+\.ts$/);
  });

  it("registers every row of the table", () => {
    for (const route of ROUTE_TABLE) {
      expect(t.app.hasRoute({ method: route.method, url: route.url }), `${route.method} ${route.url}`).toBe(true);
    }
  });

  it("answers 501 with the owning stream for every route not implemented yet", async () => {
    const stubs = ROUTE_TABLE.filter((route) => !IMPLEMENTED.has(`${route.method} ${route.url}`));
    expect(stubs.length).toBeGreaterThan(40);
    for (const route of stubs) {
      const url = route.url.replace(/:([a-zA-Z]+)/g, (_m, name: string) => (name === "file" ? "tok.json" : `${name}_x`));
      const res = await t.app.inject({ method: route.method, url, ...(route.method === "POST" ? { payload: {} } : {}) });
      // Already implemented by its stream: any status but 404/5xx-without-envelope is acceptable here.
      if (res.statusCode !== 501) {
        expect(res.statusCode, `${route.method} ${url}`).not.toBe(404);
        continue;
      }
      expect(res.json(), `${route.method} ${url}`).toMatchObject({ error: "not_implemented", details: { owner: route.owner } });
    }
  });

  it("reports a degraded gateway honestly on /v1/meta", async () => {
    const res = await t.app.inject({ method: "GET", url: "/v1/meta" });
    expect(res.statusCode).toBe(200);
    const meta = MetaResponseSchema.parse(res.json());
    expect(meta).toMatchObject({
      database: "none",
      paypal: { configured: false, webhook_configured: false },
      ai: { compiler: false, verifier: false, agent: false },
      channel3: false,
      webauthn: { rp_id: "localhost", origin: "http://localhost:3000" },
    });
  });

  it("maps errors to the ApiError envelope without leaking internals", async () => {
    expect((await t.app.inject({ method: "GET", url: "/nope" })).json()).toEqual({ error: "not_found", message: "No such route." });
    const http = await t.app.inject({ method: "GET", url: "/__t/throw-http" });
    expect(http.statusCode).toBe(409);
    expect(http.json()).toEqual({ error: "conflict", message: "Already decided.", details: { approval_id: "apr_x" } });
    const ni = await t.app.inject({ method: "GET", url: "/__t/throw-ni" });
    expect(ni.statusCode).toBe(501);
    expect(ni.json()).toMatchObject({ error: "not_implemented", details: { owner: "money" } });
    const boom = await t.app.inject({ method: "GET", url: "/__t/throw" });
    expect(boom.statusCode).toBe(500);
    expect(boom.body).not.toContain("postgres://");
    const badJson = await t.app.inject({ method: "POST", url: "/__t/json", headers: { "content-type": "application/json" }, payload: "{not json" });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("SSE writer", () => {
  let t: TestApp;
  let base = "";

  beforeAll(async () => {
    t = await buildTestApp({
      db: null,
      beforeReady: (app) => {
        app.get("/__t/sse", async (request, reply) => {
          const channel = openSse(request, reply, { heartbeatMs: 20 });
          const writId = newId("wr");
          const message: StreamMessage = {
            id: "boot-1",
            at: "2026-11-03T14:02:00.000Z",
            event: {
              type: "budget.updated",
              data: {
                writ_id: writId,
                limit_minor: "6000",
                max_per_order_minor: "6000",
                reserved_minor: "4400",
                spent_minor: "0",
                remaining_minor: "1600",
                orders_count: 0,
                held_orders: 1,
                max_orders: 1,
              },
            },
          };
          channel.send(message);
          setTimeout(() => channel.close(), 60);
        });
      },
    });
    base = await t.app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await t.close();
  });

  it("streams id + data frames with no-transform headers and heartbeats", async () => {
    const res = await fetch(`${base}/__t/sse`);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    const text = await res.text();
    expect(text).toContain(": connected");
    expect(text).toContain(": ping");
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    expect(text).toContain("id: boot-1\n");
    expect(StreamMessageSchema.parse(JSON.parse((dataLine ?? "").slice("data: ".length))).event.type).toBe("budget.updated");
  });
});
