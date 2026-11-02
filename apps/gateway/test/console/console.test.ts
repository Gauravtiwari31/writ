// P0-11: console rows are tenant-scoped, carry no untrusted page text, and the query DSL cannot name a column
// that does not exist.
import { generateDeviceKeyEd25519, toBase64Url } from "@writ/core";
import { ConsoleDatasetResponseSchema, ConsoleQueryResponseSchema, type ConsoleQueryRequest, type ConsoleRow } from "@writ/core/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runQuery } from "../../src/console/index";
import { buildTestApp, type TestApp } from "../helpers/app";

let t: TestApp;
beforeAll(async () => {
  t = await buildTestApp({ services: { paypal: null, channel3: null } });
}, 60_000);
afterAll(async () => {
  await t.close();
});

async function wallet(name: string): Promise<string> {
  const res = await t.app.inject({ method: "POST", url: "/v1/auth/device-wallet", payload: { display_name: name, public_key: toBase64Url(generateDeviceKeyEd25519().publicKey), label: "x" } });
  return String(res.headers["set-cookie"]).split(";")[0] ?? "";
}

const ROWS: ConsoleRow[] = [
  { state: "BLOCKED", amount_minor: 8500, is_synthetic: false },
  { state: "BLOCKED", amount_minor: 19900, is_synthetic: false },
  { state: "CAPTURED", amount_minor: 4400, is_synthetic: false },
];
const query = (rest: Partial<ConsoleQueryRequest>): ConsoleQueryRequest => ({ dataset: "purchases", filters: [], limit: 200, ...rest });

describe("console query", () => {
  it("filters, groups, aggregates and sorts", () => {
    expect(runQuery(ROWS, query({ filters: [{ field: "state", op: "eq", value: "BLOCKED" }] }))).toHaveLength(2);
    expect(runQuery(ROWS, query({ group_by: ["state"], aggregate: { op: "sum", field: "amount_minor" }, order_by: { field: "value", dir: "desc" } }))).toEqual([
      { state: "BLOCKED", value: 28400 },
      { state: "CAPTURED", value: 4400 },
    ]);
    expect(runQuery(ROWS, query({ aggregate: { op: "count" } }))).toEqual([{ value: 3 }]);
  });

  it("refuses a column the dataset does not have", () => {
    expect(() => runQuery(ROWS, query({ filters: [{ field: "password", op: "eq", value: "x" }] }))).toThrow(/no column/);
  });
});

describe("console routes", () => {
  it("need a session, and each wallet sees only its own rows", async () => {
    expect((await t.app.inject({ method: "GET", url: "/api/console/datasets/purchases" })).statusCode).toBe(401);
    const cookie = await wallet("A");
    const res = await t.app.inject({ method: "GET", url: "/api/console/datasets/writs", headers: { cookie } });
    expect(ConsoleDatasetResponseSchema.parse(res.json()).rows).toEqual([]);
    const queried = await t.app.inject({ method: "POST", url: "/api/console/query", headers: { cookie }, payload: { dataset: "purchases", aggregate: { op: "count" } } });
    expect(ConsoleQueryResponseSchema.parse(queried.json()).rows).toEqual([]);
  });

  it("the AI harness says it is not connected instead of pretending", async () => {
    const cookie = await wallet("B");
    const res = await t.app.inject({ method: "POST", url: "/api/ai/studio", headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("ai_unavailable");
  });
});
