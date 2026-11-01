import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  appendEvent,
  computeEventHash,
  eventHashPreimage,
  GENESIS_PREV_HASH,
  toLedgerTimestamp,
  LEDGER_EVENT_TYPES,
  PAYLOAD_SCHEMAS,
  verifyChain,
  type AppendEventInput,
  type ChainFailureReason,
  type JsonObject,
  type LedgerEvent,
  type LedgerEventType,
} from "../src/index";
import { OTHER_PURCHASE_ID, OTHER_WRIT_ID, otherHex } from "./fixtures";

const W = "wr_01m6gv0000a0b1c2d3e4f5g6h7";
const P = "pur_01m6gv0001h7g6f5e4d3c2b1a0";

/** Independent reference: node:crypto + Buffer + a key-sorting serializer (enough for string-only payloads). */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function referenceHash(prevHex: string, type: string, payload: unknown, ts: string): string {
  const lp = (text: string): Buffer => {
    const body = Buffer.from(text, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    return Buffer.concat([length, body]);
  };
  const preimage = Buffer.concat([Buffer.from(prevHex, "hex"), lp(type), lp(stable(payload)), lp(ts)]);
  return createHash("sha256").update(preimage).digest("hex");
}

const goldenInputs: (AppendEventInput & { purchase_id: string | null })[] = [
  { type: "WRIT_SIGNED", ts: "2026-11-03T14:02:00.000Z", writ_id: W, purchase_id: null, payload: { writ_hash: "ab".repeat(32) } },
  {
    type: "CART_PROPOSED",
    ts: "2026-11-03T14:05:12.345Z",
    purchase_id: P,
    payload: { cart_hash: "cd".repeat(32), note: "Hand-thrown ceramic pour-over set — ☕" },
  },
  {
    type: "PAYPAL_ORDER_CREATED",
    ts: "2026-11-03T14:05:13.000Z",
    purchase_id: P,
    payload: {
      order_id: "5O190127TN364715T",
      custom_id: `writ:golden01:${"ef".repeat(20)}`,
      c_pre: "ef".repeat(32),
      amount_minor: "4400",
      currency: "USD",
      debug_id: "f1e2d3c4b5a69",
    },
  },
  {
    type: "PAYPAL_CAPTURED",
    ts: "2026-11-03T14:09:59.999Z",
    purchase_id: P,
    payload: {
      authorization_id: "0VF52814937998046",
      capture_id: "3C679366HH908993F",
      amount_minor: "4400",
      currency: "USD",
      c_post: "12".repeat(32),
      invoice_id: `wv-${"12".repeat(20)}`,
    },
  },
];

function goldenChain(): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  for (const input of goldenInputs) events.push(appendEvent(events[events.length - 1] ?? null, input));
  return events;
}

/** A plain chain with BIGSERIAL-style gaps in seq (10, 20, 30, …). */
function sampleChain(length = 6, writId = W): LedgerEvent[] {
  const types: LedgerEventType[] = ["CART_PROPOSED", "POLICY_DECIDED", "BUDGET_RESERVED", "SENTINEL_SCANNED", "VERIFIER_DECIDED", "BUDGET_SETTLED"];
  const events = [
    appendEvent(null, { type: "WRIT_SIGNED", writ_id: writId, seq: 10, ts: "2026-11-03T14:02:00.000Z", payload: { writ_hash: "ab".repeat(32) } }),
  ];
  for (let i = 1; i < length; i++) {
    const tail = events[i - 1] as LedgerEvent;
    events.push(
      appendEvent(tail, {
        type: types[(i - 1) % types.length] as LedgerEventType,
        purchase_id: i % 3 === 0 ? null : P,
        seq: tail.seq + 10,
        ts: new Date(Date.parse("2026-11-03T14:02:00.000Z") + i * 1000),
        payload: { step: i },
      }),
    );
  }
  return events;
}

const at = <T>(list: readonly T[], index: number): T => {
  const item = list[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
};

function expectFailure(events: readonly unknown[], index: number, reason: ChainFailureReason): void {
  const result = verifyChain(events);
  expect(result).toMatchObject({ ok: false, index, reason });
}

describe("golden vector", () => {
  it("pins the chain encoding (independent node:crypto reference + literal head)", () => {
    const events = goldenChain();
    let prev = GENESIS_PREV_HASH;
    events.forEach((event, i) => {
      expect(event.prev_hash).toBe(prev);
      expect(event.hash).toBe(referenceHash(prev, event.type, event.payload, at(goldenInputs, i).ts as string));
      prev = event.hash;
    });
    expect(events.map((event) => event.hash)).toEqual([
      "3ed1ffb267a1746389e561b9bb1536a95c3e46776e2b3cea3cbac6321e6e66c5",
      "b7ed30631bf261ab36a2648a13f7a6c48622ac33060214ad20188a21e0a5fb56",
      "b096e1d4105a575d1dfc490e8dc0e8e462a8505fa8e6643dac0be6de074f1c83",
      "e901607afe29dbf7c19376b0022e23493dd61be4407e1be74a7cf04b04cb075b",
    ]);
    expect(verifyChain(events)).toEqual({ ok: true });
  });

  it("hashes prev_hash ‖ lp(type) ‖ lp(JCS(payload)) ‖ lp(ts)", () => {
    const genesis = at(goldenChain(), 0);
    const jcsPayload = `{"writ_hash":"${"ab".repeat(32)}","writ_id":"${W}"}`;
    const preimage = eventHashPreimage(genesis);
    const expected = Buffer.concat([
      Buffer.alloc(32),
      Buffer.from([0, 0, 0, 11]),
      Buffer.from("WRIT_SIGNED"),
      Buffer.from([0, 0, 0, jcsPayload.length]),
      Buffer.from(jcsPayload),
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("2026-11-03T14:02:00.000Z"),
    ]);
    expect(Buffer.from(preimage).equals(expected)).toBe(true);
    expect(computeEventHash(genesis)).toBe(createHash("sha256").update(expected).digest("hex"));
  });
});

describe("appendEvent", () => {
  it("links events, inherits writ_id, defaults seq and binds purchase_id into the payload", () => {
    const events = goldenChain();
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(events.every((event) => event.writ_id === W)).toBe(true);
    expect(at(events, 0).prev_hash).toBe(GENESIS_PREV_HASH);
    expect(at(events, 0).purchase_id).toBeNull();
    expect(at(events, 0).payload).toEqual({ writ_hash: "ab".repeat(32), writ_id: W });
    expect(at(events, 1).payload["purchase_id"]).toBe(P);
    expect(at(events, 1).purchase_id).toBe(P);
    for (let i = 1; i < events.length; i++) expect(at(events, i).prev_hash).toBe(at(events, i - 1).hash);
  });

  it("copies the payload so later mutation cannot desynchronize the hash", () => {
    const payload: JsonObject = { writ_hash: "ab".repeat(32), nested: { n: 1 } };
    const genesis = appendEvent(null, { type: "WRIT_SIGNED", writ_id: W, ts: "2026-11-03T14:02:00.000Z", payload });
    (payload["nested"] as JsonObject)["n"] = 2;
    payload["extra"] = true;
    expect(verifyChain([genesis])).toEqual({ ok: true });
    expect(genesis.payload).toEqual({ writ_hash: "ab".repeat(32), nested: { n: 1 }, writ_id: W });
  });

  it("formats timestamps exactly as hashed, and refuses ones that cannot be", () => {
    expect(toLedgerTimestamp(new Date(Date.UTC(2026, 10, 3, 14, 2, 0, 7)))).toBe("2026-11-03T14:02:00.007Z");
    expect(() => toLedgerTimestamp(new Date(Number.NaN))).toThrow();
    expect(() => toLedgerTimestamp(new Date(Date.UTC(10_000, 0, 1)))).toThrow();
  });

  it("hashes only JSON-object payloads", () => {
    const genesis = at(goldenChain(), 0);
    expect(() => computeEventHash({ ...genesis, payload: ["x"] as unknown as JsonObject })).toThrow(TypeError);
    expect(() => computeEventHash({ ...genesis, prev_hash: "00" })).toThrow(TypeError);
  });

  it("accepts a Date and stores ISO 8601 UTC with milliseconds", () => {
    const genesis = appendEvent(null, { type: "WRIT_SIGNED", writ_id: W, ts: new Date(Date.UTC(2026, 10, 3, 14, 2)), payload: { writ_hash: "ab".repeat(32) } });
    expect(genesis.ts).toBe("2026-11-03T14:02:00.000Z");
  });

  it("allows seq gaps but never a non-increasing seq", () => {
    const genesis = at(goldenChain(), 0);
    expect(appendEvent(genesis, { type: "KILL_SWITCH", ts: "2026-11-03T15:00:00.000Z", seq: 99, payload: {} }).seq).toBe(99);
    expect(() => appendEvent(genesis, { type: "KILL_SWITCH", ts: "2026-11-03T15:00:00.000Z", seq: 1, payload: {} })).toThrow(RangeError);
  });

  const genesisInput = { type: "WRIT_SIGNED", writ_id: W, ts: "2026-11-03T14:02:00.000Z", payload: { writ_hash: "ab".repeat(32) } } as const;
  const later = (overrides: Partial<AppendEventInput>): AppendEventInput => ({
    type: "CART_PROPOSED",
    ts: "2026-11-03T14:05:00.000Z",
    purchase_id: P,
    payload: {},
    ...overrides,
  });

  const withGenesis = (input: AppendEventInput): LedgerEvent => appendEvent(appendEvent(null, genesisInput), input);
  // JSON.parse(JSON.stringify(...)) drops the `undefined` fields the rows use to delete a key.
  const paypal = (type: LedgerEventType, payload: Record<string, unknown>): AppendEventInput =>
    later({ type, payload: JSON.parse(JSON.stringify(payload)) as JsonObject });
  const orderPayload = { order_id: "O1", custom_id: `writ:golden01:${"ef".repeat(20)}`, c_pre: "ef".repeat(32), amount_minor: "4400", currency: "USD" };
  const capturePayload = {
    authorization_id: "A1",
    capture_id: "C1",
    amount_minor: "4400",
    currency: "USD",
    c_post: "12".repeat(32),
    invoice_id: `wv-${"12".repeat(20)}`,
  };

  it.each<[string, () => unknown]>([
    ["genesis that is not WRIT_SIGNED", () => appendEvent(null, { ...genesisInput, type: "CART_PROPOSED" })],
    ["genesis without writ_id", () => appendEvent(null, { ...genesisInput, writ_id: undefined })],
    ["purchase-scoped genesis", () => appendEvent(null, { ...genesisInput, purchase_id: P })],
    ["genesis payload naming another writ", () => appendEvent(null, { ...genesisInput, payload: { writ_hash: "ab".repeat(32), writ_id: OTHER_WRIT_ID } })],
    ["genesis payload without writ_hash", () => appendEvent(null, { ...genesisInput, payload: {} })],
    ["a second WRIT_SIGNED", () => appendEvent(appendEvent(null, genesisInput), { ...genesisInput })],
    ["an event for another writ", () => appendEvent(appendEvent(null, genesisInput), later({ writ_id: OTHER_WRIT_ID }))],
    ["payload.purchase_id disagreeing", () => appendEvent(appendEvent(null, genesisInput), later({ payload: { purchase_id: OTHER_PURCHASE_ID } }))],
    ["payload.purchase_id without an event purchase_id", () => appendEvent(appendEvent(null, genesisInput), later({ purchase_id: null, payload: { purchase_id: P } }))],
    ["a non-object payload", () => appendEvent(appendEvent(null, genesisInput), later({ payload: ["x"] as unknown as JsonObject }))],
    ["a non-JSON payload", () => appendEvent(appendEvent(null, genesisInput), later({ payload: { n: Number.NaN } }))],
    ["an unknown type", () => appendEvent(appendEvent(null, genesisInput), later({ type: "MONEY_MOVED" as LedgerEventType }))],
    ["ts without milliseconds", () => appendEvent(null, { ...genesisInput, ts: "2026-11-03T14:02:00Z" })],
    ["ts with an offset", () => appendEvent(null, { ...genesisInput, ts: "2026-11-03T14:02:00.000+05:30" })],
    ["an impossible date", () => appendEvent(null, { ...genesisInput, ts: "2026-02-30T14:02:00.000Z" })],
    ["a writ_id that is not a core wr_ id", () => appendEvent(null, { ...genesisInput, writ_id: "writ_7f3a9c21" })],
    ["a purchase_id that is not a core pur_ id", () => appendEvent(appendEvent(null, genesisInput), later({ purchase_id: "pur_01HZX8K2" }))],
    ["PAYPAL_CAPTURED without capture_id", () => withGenesis(paypal("PAYPAL_CAPTURED", { ...capturePayload, capture_id: undefined }))],
    ["PAYPAL_CAPTURED without c_post", () => withGenesis(paypal("PAYPAL_CAPTURED", { ...capturePayload, c_post: undefined }))],
    ["an invoice_id that does not embed c_post", () => withGenesis(paypal("PAYPAL_CAPTURED", { ...capturePayload, c_post: "34".repeat(32) }))],
    ["a float amount", () => withGenesis(paypal("PAYPAL_ORDER_CREATED", { ...orderPayload, amount_minor: 44.0 }))],
    ["PAYPAL_ORDER_CREATED without c_pre", () => withGenesis(paypal("PAYPAL_ORDER_CREATED", { ...orderPayload, c_pre: undefined }))],
    ["a custom_id that does not embed c_pre", () => withGenesis(paypal("PAYPAL_ORDER_CREATED", { ...orderPayload, c_pre: "34".repeat(32) }))],
    ["a custom_id that is not writ:<short>:<hex>", () => withGenesis(paypal("PAYPAL_ORDER_CREATED", { ...orderPayload, custom_id: `writ:X:${"ef".repeat(20)}` }))],
    ["PAYPAL_VOIDED without c_post", () => withGenesis(paypal("PAYPAL_VOIDED", { authorization_id: "A1" }))],
    ["a PayPal event without a purchase", () => withGenesis({ ...paypal("PAYPAL_AUTHORIZED", { order_id: "O1", authorization_id: "A1" }), purchase_id: null })],
  ])("rejects %s", (_name, run) => {
    expect(run).toThrow();
  });

  it("accepts the PayPal payloads those rows were derived from", () => {
    expect(() => withGenesis(paypal("PAYPAL_ORDER_CREATED", orderPayload))).not.toThrow();
    expect(() => withGenesis(paypal("PAYPAL_CAPTURED", capturePayload))).not.toThrow();
    expect(() => withGenesis(paypal("PAYPAL_CAPTURED", { ...capturePayload, invoice_id: null }))).not.toThrow();
    expect(() => withGenesis(paypal("PAYPAL_VOIDED", { authorization_id: "A1", c_post: null }))).not.toThrow();
  });
});

describe("verifyChain", () => {
  it("accepts an untouched chain, including seq gaps and null purchase_ids", () => {
    expect(verifyChain(sampleChain())).toEqual({ ok: true });
    expect(verifyChain(goldenChain())).toEqual({ ok: true });
  });

  it("rejects an empty chain", () => {
    expectFailure([], 0, "EMPTY_CHAIN");
  });

  it("rejects malformed events", () => {
    const events = sampleChain();
    expectFailure([...events.slice(0, 2), { ...at(events, 2), hash: at(events, 2).hash.toUpperCase() }], 2, "MALFORMED_EVENT");
    expectFailure([at(events, 0), "junk"], 1, "MALFORMED_EVENT");
    expectFailure([at(events, 0), null], 1, "MALFORMED_EVENT");
    expectFailure([at(events, 0), { ...at(events, 1), tenant_id: "t1" }], 1, "MALFORMED_EVENT");
    expectFailure([at(events, 0), { ...at(events, 1), ts: "2026-11-03T14:02:01Z" }], 1, "MALFORMED_EVENT");
  });

  it("detects an edited payload", () => {
    const events = sampleChain();
    events[3] = { ...at(events, 3), payload: { ...at(events, 3).payload, step: 300 } };
    expectFailure(events, 3, "HASH_MISMATCH");
  });

  it("detects an edited genesis payload", () => {
    const events = sampleChain();
    events[0] = { ...at(events, 0), payload: { ...at(events, 0).payload, writ_hash: "cd".repeat(32) } };
    expectFailure(events, 0, "HASH_MISMATCH");
  });

  it("detects an edited type", () => {
    const events = sampleChain();
    events[2] = { ...at(events, 2), type: "REFUNDED" };
    expectFailure(events, 2, "HASH_MISMATCH");
    events[2] = { ...at(events, 2), type: "WRIT_SIGNED" };
    expectFailure(events, 2, "WRIT_SIGNED_NOT_GENESIS");
  });

  it("detects an edited timestamp", () => {
    const events = sampleChain();
    events[4] = { ...at(events, 4), ts: "2026-11-03T14:02:04.001Z" };
    expectFailure(events, 4, "HASH_MISMATCH");
  });

  it("detects reordering, with or without renumbered seq", () => {
    const events = sampleChain();
    const swapped = [...events];
    swapped[2] = at(events, 3);
    swapped[3] = at(events, 2);
    expectFailure(swapped, 2, "PREV_HASH_MISMATCH");

    const renumbered = swapped.map((event, i) => ({ ...event, seq: (i + 1) * 10 }));
    expectFailure(renumbered, 2, "PREV_HASH_MISMATCH");

    expectFailure([at(events, 1), at(events, 0), ...events.slice(2)], 0, "GENESIS_NOT_WRIT_SIGNED");
  });

  it("detects deletion before the tail", () => {
    const events = sampleChain();
    expectFailure([...events.slice(0, 2), ...events.slice(3)], 2, "PREV_HASH_MISMATCH");
    expectFailure(events.slice(1), 0, "GENESIS_NOT_WRIT_SIGNED");
  });

  it("detects insertion before the tail", () => {
    const events = sampleChain();
    const forged = appendEvent(at(events, 1), { type: "PAYPAL_VOIDED", purchase_id: P, seq: at(events, 1).seq + 5, ts: "2026-11-03T14:02:01.500Z", payload: { authorization_id: "FAKE", c_post: null } });
    expectFailure([...events.slice(0, 2), forged, ...events.slice(2)], 3, "PREV_HASH_MISMATCH");
  });

  it("detects a forged hash, even when the next prev_hash is patched to match", () => {
    const events = sampleChain();
    const fake = otherHex(at(events, 2).hash);
    events[2] = { ...at(events, 2), hash: fake };
    expectFailure(events, 2, "HASH_MISMATCH");
    events[3] = { ...at(events, 3), prev_hash: fake };
    expectFailure(events, 2, "HASH_MISMATCH");
  });

  it("detects a wrong genesis prev_hash, even when the genesis hash is recomputed", () => {
    const events = sampleChain();
    const genesis = at(events, 0);
    const prev_hash = "11".repeat(32);
    events[0] = { ...genesis, prev_hash, hash: computeEventHash({ ...genesis, prev_hash }) };
    expectFailure(events, 0, "BAD_GENESIS_PREV_HASH");
  });

  it("detects mixed writ_ids", () => {
    const events = sampleChain();
    expectFailure([...events.slice(0, 3), { ...at(events, 3), writ_id: OTHER_WRIT_ID }, ...events.slice(4)], 3, "WRIT_ID_MISMATCH");
    expectFailure([{ ...at(events, 0), writ_id: OTHER_WRIT_ID }, ...events.slice(1)], 0, "WRIT_ID_MISMATCH");

    const other = sampleChain(4, OTHER_WRIT_ID);
    expectFailure([...events, ...other], events.length, "WRIT_SIGNED_NOT_GENESIS");
    const graft = appendEvent(at(other, 0), { type: "REFUNDED", purchase_id: P, seq: at(events, events.length - 1).seq + 1, ts: "2026-11-03T15:00:00.000Z", payload: {} });
    expectFailure([...events, graft], events.length, "WRIT_ID_MISMATCH");
  });

  it("detects a non-monotonic or duplicated seq", () => {
    const events = sampleChain();
    expectFailure([...events.slice(0, 4), { ...at(events, 4), seq: at(events, 3).seq - 1 }, ...events.slice(5)], 4, "SEQ_NOT_INCREASING");
    expectFailure([...events.slice(0, 4), { ...at(events, 4), seq: at(events, 3).seq }, ...events.slice(5)], 4, "SEQ_NOT_INCREASING");
  });

  it("binds the purchase_id column through payload.purchase_id", () => {
    const events = sampleChain();
    expect(at(events, 1).purchase_id).toBe(P);
    expectFailure([at(events, 0), { ...at(events, 1), purchase_id: OTHER_PURCHASE_ID }, ...events.slice(2)], 1, "PURCHASE_ID_MISMATCH");
    expect(at(events, 3).purchase_id).toBeNull();
    expectFailure([...events.slice(0, 3), { ...at(events, 3), purchase_id: P }, ...events.slice(4)], 3, "PURCHASE_ID_MISMATCH");
  });

  it("rejects a purchase-scoped WRIT_SIGNED even when its hash is recomputed", () => {
    const genesis = at(sampleChain(), 0);
    const payload = { ...genesis.payload, purchase_id: P };
    expectFailure([{ ...genesis, purchase_id: P, payload, hash: computeEventHash({ ...genesis, payload }) }], 0, "PURCHASE_ID_MISMATCH");
  });

  it("cannot see truncation at the tail (documented: the evidence pack checks PayPal events instead)", () => {
    expect(verifyChain(sampleChain().slice(0, -1))).toEqual({ ok: true });
  });

  it("detects every single tamper before the tail (property)", () => {
    const freeTypes = LEDGER_EVENT_TYPES.filter((type) => type !== "WRIT_SIGNED" && !(type in PAYLOAD_SCHEMAS));
    const payloadArb = fc.dictionary(fc.stringMatching(/^[a-m]{1,6}$/), fc.jsonValue({ maxDepth: 2 }), { maxKeys: 4 }) as unknown as fc.Arbitrary<JsonObject>;
    const stepArb = fc.record({ type: fc.constantFrom(...freeTypes), payload: payloadArb, scoped: fc.boolean(), gap: fc.integer({ min: 1, max: 1000 }), dt: fc.integer({ min: 0, max: 86_400_000 }) });
    const tamperArb = fc.constantFrom("payload", "type", "ts", "hash", "prev_hash", "seq", "writ_id", "purchase_id", "swap", "delete", "duplicate");

    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 2, maxLength: 8 }), tamperArb, fc.nat(), (steps, tamper, pick) => {
        const events: LedgerEvent[] = [appendEvent(null, { type: "WRIT_SIGNED", writ_id: W, ts: "2026-11-03T14:02:00.000Z", payload: { writ_hash: "ab".repeat(32) } })];
        let clock = Date.parse("2026-11-03T14:02:00.000Z");
        for (const step of steps) {
          const tail = at(events, events.length - 1);
          clock += step.dt;
          events.push(appendEvent(tail, { type: step.type, payload: step.payload, purchase_id: step.scoped ? P : null, seq: tail.seq + step.gap, ts: new Date(clock) }));
        }
        expect(verifyChain(events)).toEqual({ ok: true });

        // Tamper with any event except the tail (tail edits other than truncation are covered too).
        const i = pick % (events.length - 1);
        const target = at(events, i);
        const copy = [...events];
        switch (tamper) {
          case "payload":
            copy[i] = { ...target, payload: { ...target.payload, tampered: true } };
            break;
          case "type":
            copy[i] = { ...target, type: target.type === "REFUNDED" ? "KILL_SWITCH" : "REFUNDED" };
            break;
          case "ts":
            copy[i] = { ...target, ts: new Date(Date.parse(target.ts) + 1).toISOString() };
            break;
          case "hash":
            copy[i] = { ...target, hash: otherHex(target.hash) };
            break;
          case "prev_hash":
            copy[i] = { ...target, prev_hash: otherHex(target.prev_hash) };
            break;
          case "seq":
            copy[i + 1] = { ...at(events, i + 1), seq: target.seq };
            break;
          case "writ_id":
            copy[i] = { ...target, writ_id: OTHER_WRIT_ID };
            break;
          case "purchase_id":
            copy[i] = { ...target, purchase_id: target.purchase_id === null ? P : null };
            break;
          case "swap":
            copy[i] = at(events, i + 1);
            copy[i + 1] = target;
            break;
          case "delete":
            copy.splice(i, 1);
            break;
          case "duplicate":
            copy.splice(i, 0, target);
            break;
        }
        expect(verifyChain(copy).ok).toBe(false);
      }),
      { numRuns: 400 },
    );
  });
});
