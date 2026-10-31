import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  concatBytes,
  equalBytes,
  fromBase64Url,
  fromHex,
  hashJcsHex,
  jcs,
  lengthPrefixed,
  minorToPayPalValue,
  minorToString,
  parseMinor,
  payPalValueToMinor,
  sha256,
  toBase64Url,
  toHex,
  utf8,
} from "../src/index";

describe("jcs", () => {
  it("sorts keys and is stable regardless of insertion order", () => {
    expect(jcs({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(hashJcsHex({ a: 1, b: { d: 2, c: 3 } })).toBe(hashJcsHex({ b: { c: 3, d: 2 }, a: 1 }));
  });

  it("matches RFC 8785 number serialization", () => {
    expect(jcs({ n: 1e21, m: 0.000001, z: -0 })).toBe('{"m":0.000001,"n":1e+21,"z":0}');
  });

  it.each([
    ["undefined property", { a: undefined }],
    ["bigint", { a: 1n }],
    ["NaN", { a: Number.NaN }],
    ["Infinity", [Number.POSITIVE_INFINITY]],
    ["Date", { a: new Date(0) }],
    ["function", { a: () => 1 }],
    ["class instance", { a: new Map() }],
  ])("rejects %s instead of silently dropping it", (_name, value) => {
    expect(() => jcs(value)).toThrow(TypeError);
  });

  it("accepts null-prototype objects", () => {
    const obj = Object.assign(Object.create(null) as object, { k: "v" });
    expect(jcs(obj)).toBe('{"k":"v"}');
  });
});

describe("sha256", () => {
  it("matches the FIPS 180-2 test vector", () => {
    expect(toHex(sha256("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(toHex(sha256(utf8("abc")))).toBe(toHex(sha256("abc")));
  });
});

describe("bytes", () => {
  it("round-trips hex and base64url", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        expect(fromHex(toHex(bytes))).toEqual(bytes);
        expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
      }),
    );
  });

  it("rejects malformed encodings", () => {
    expect(() => fromHex("abc")).toThrow(TypeError);
    expect(() => fromHex("ABCD")).toThrow(TypeError);
    expect(() => fromBase64Url("a+b/")).toThrow(TypeError);
    expect(() => fromBase64Url("abcde")).toThrow(TypeError);
  });

  it("concatenates, length-prefixes and compares", () => {
    expect(concatBytes(utf8("ab"), utf8("c"))).toEqual(utf8("abc"));
    expect(toHex(lengthPrefixed(utf8("hi")))).toBe("000000026869");
    expect(equalBytes(utf8("abc"), utf8("abc"))).toBe(true);
    expect(equalBytes(utf8("abc"), utf8("abd"))).toBe(false);
    expect(equalBytes(utf8("abc"), utf8("ab"))).toBe(false);
  });
});

describe("money", () => {
  it("converts minor units to PayPal values and back", () => {
    expect(minorToPayPalValue(4400n, "USD")).toBe("44.00");
    expect(minorToPayPalValue(5n, "USD")).toBe("0.05");
    expect(minorToPayPalValue(0n, "USD")).toBe("0.00");
    expect(payPalValueToMinor("44.00", "USD")).toBe(4400n);
    expect(payPalValueToMinor("44", "USD")).toBe(4400n);
    expect(payPalValueToMinor("0.05", "USD")).toBe(5n);
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), (minor) => {
        expect(payPalValueToMinor(minorToPayPalValue(minor, "USD"), "USD")).toBe(minor);
      }),
    );
  });

  it.each(["44.5", "44.000", "-1.00", "01.00", "1e3", "", " 1.00", "1,000.00"])(
    "rejects malformed PayPal value %j",
    (value) => {
      expect(() => payPalValueToMinor(value, "USD")).toThrow(TypeError);
    },
  );

  it("parses and prints minor-unit strings strictly", () => {
    expect(parseMinor("6000")).toBe(6000n);
    expect(minorToString(6000n)).toBe("6000");
    for (const bad of ["-1", "01", "1.0", "", "12345678901234567"]) expect(() => parseMinor(bad)).toThrow(TypeError);
    expect(() => minorToString(-1n)).toThrow(RangeError);
    expect(() => minorToString(10n ** 17n)).toThrow(RangeError);
    expect(() => minorToPayPalValue(-1n, "USD")).toThrow(RangeError);
  });
});
