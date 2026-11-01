import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  commitPre,
  ID_PREFIXES,
  idSchema,
  idTimestamp,
  isId,
  MerchantIdSchema,
  newId,
  parseCustomId,
  sha256,
  toCustomId,
  writShort,
  type IdPrefix,
} from "../src/index";

const ULID_RE = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const T = Date.parse("2026-11-03T14:02:00.000Z");

describe("newId", () => {
  it.each(ID_PREFIXES)("formats %s ids as <prefix>_<26 Crockford base32 chars>", (prefix) => {
    const id = newId(prefix);
    const [head, body] = id.split("_");
    expect(head).toBe(prefix);
    expect(body).toMatch(ULID_RE);
    expect(idSchema(prefix).safeParse(id).success).toBe(true);
    expect(isId(prefix, id)).toBe(true);
  });

  it("does not collide", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId("pur", () => T)));
    expect(ids.size).toBe(10_000);
  });

  it("encodes the injected clock in the time prefix", () => {
    expect(newId("wr", () => 0).slice(3, 13)).toBe("0000000000");
    expect(newId("wr", () => 2 ** 48 - 1).slice(3, 13)).toBe("7zzzzzzzzz");
    expect(newId("wr", () => T).slice(3, 13)).toBe("01m6gvezy0");
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 48 - 1 }), (time) => {
        expect(idTimestamp(newId("crt", () => time))).toBe(time);
      }),
    );
  });

  it("sorts by creation time", () => {
    const earlier = newId("wr", () => T);
    const later = newId("wr", () => T + 1);
    expect(earlier < later).toBe(true);
  });

  it("rejects clocks outside the 48-bit millisecond range and unknown prefixes", () => {
    expect(() => newId("wr", () => -1)).toThrow(RangeError);
    expect(() => newId("wr", () => 1.5)).toThrow(RangeError);
    expect(() => newId("wr", () => 2 ** 48)).toThrow(RangeError);
    expect(() => newId("wr", () => Number.NaN)).toThrow(RangeError);
    expect(() => newId("xx" as IdPrefix)).toThrow(TypeError);
  });
});

describe("idSchema", () => {
  const id = "wr_01m6gvezy0dr1r16bxj90g7evg";

  it.each([
    ["another prefix", "crt_01m6gvezy0dr1r16bxj90g7evg"],
    ["upper case", id.toUpperCase()],
    ["a short body", id.slice(0, -1)],
    ["a long body", `${id}0`],
    ["an excluded letter (i)", "wr_01m6gvezy0dr1r16bxj90g7evi"],
    ["an excluded letter (u)", "wr_01m6gvezy0dr1r16bxj90g7evu"],
    ["a time overflow (first char 8)", "wr_81m6gvezy0dr1r16bxj90g7evg"],
    ["no separator", "wr01m6gvezy0dr1r16bxj90g7evg"],
  ])("rejects %s", (_name, candidate) => {
    expect(idSchema("wr").safeParse(candidate).success).toBe(false);
  });

  it("checks the prefix in isId", () => {
    expect(isId("wr", id)).toBe(true);
    expect(isId("crt", id)).toBe(false);
    expect(isId("wr", "nope")).toBe(false);
    expect(() => idTimestamp("nope")).toThrow(TypeError);
  });
});

describe("writShort", () => {
  it("takes 12 chars from the random part, not the time part", () => {
    expect(writShort("wr_01m6gvezy0dr1r16bxj90g7evg")).toBe("dr1r16bxj90g");
    const a = newId("wr", () => T);
    const b = newId("wr", () => T);
    expect(writShort(a)).toMatch(/^[a-z0-9]{12}$/);
    expect(writShort(a)).not.toBe(writShort(b));
  });

  it("fits the PayPal custom_id format", () => {
    const short = writShort(newId("wr"));
    const customId = toCustomId(short, commitPre(sha256("w"), sha256("c"), sha256("p")));
    expect(parseCustomId(customId)?.writShort).toBe(short);
  });

  it("only accepts writ ids", () => {
    expect(() => writShort("crt_01m6gvezy0dr1r16bxj90g7evg")).toThrow(TypeError);
    expect(() => writShort("wr_short")).toThrow(TypeError);
  });
});

describe("MerchantIdSchema", () => {
  it.each(["writ-market", "etsy.com", "shop:1234", "a"])("accepts %s", (id) => {
    expect(MerchantIdSchema.safeParse(id).success).toBe(true);
  });

  it.each(["", "Etsy.com", "-x", "x-", "etsy com", "m".repeat(65), "shop/1"])("rejects %j", (id) => {
    expect(MerchantIdSchema.safeParse(id).success).toBe(false);
  });
});
