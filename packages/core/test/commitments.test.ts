import { describe, expect, it } from "vitest";
import {
  commitPost,
  commitPre,
  concatBytes,
  customIdMatches,
  invoiceIdMatches,
  parseCustomId,
  parseInvoiceId,
  sha256,
  toCustomId,
  toHex,
  toInvoiceId,
  ZERO_HASH,
} from "../src/index";

const hW = sha256("writ");
const hC = sha256("cart");
const hP = sha256("policy");
const hV = sha256("verifier");
const hA = sha256("approval");

describe("commitments", () => {
  it("computes C_pre and C_post exactly as plan §6.7 specifies", () => {
    const cPre = commitPre(hW, hC, hP);
    expect(toHex(cPre)).toBe(toHex(sha256(concatBytes(hW, hC, hP))));
    expect(toHex(commitPost(cPre, hV, hA))).toBe(toHex(sha256(concatBytes(cPre, hV, hA))));
    expect(toHex(commitPost(cPre, hV, null))).toBe(toHex(sha256(concatBytes(cPre, hV, ZERO_HASH))));
  });

  it("changes when any input changes", () => {
    const base = toHex(commitPre(hW, hC, hP));
    expect(toHex(commitPre(hW, sha256("cart2"), hP))).not.toBe(base);
    expect(toHex(commitPre(hC, hW, hP))).not.toBe(base);
  });

  it("rejects inputs that are not 32-byte hashes", () => {
    expect(() => commitPre(new Uint8Array(31), hC, hP)).toThrow(RangeError);
    expect(() => commitPost(commitPre(hW, hC, hP), hV, new Uint8Array(1))).toThrow(RangeError);
  });

  it("formats and parses PayPal anchor fields", () => {
    const cPre = commitPre(hW, hC, hP);
    const cPost = commitPost(cPre, hV, hA);
    const customId = toCustomId("ab12cd34", cPre);
    const invoiceId = toInvoiceId(cPost);

    expect(customId).toBe(`writ:ab12cd34:${toHex(cPre).slice(0, 40)}`);
    expect(customId.length).toBeLessThanOrEqual(127);
    expect(invoiceId).toBe(`wv-${toHex(cPost).slice(0, 40)}`);
    expect(parseCustomId(customId)).toEqual({ writShort: "ab12cd34", cPrePrefix: toHex(cPre).slice(0, 40) });
    expect(parseInvoiceId(invoiceId)).toEqual({ cPostPrefix: toHex(cPost).slice(0, 40) });

    expect(customIdMatches(customId, "ab12cd34", cPre)).toBe(true);
    expect(customIdMatches(customId, "ab12cd35", cPre)).toBe(false);
    expect(customIdMatches(customId, "ab12cd34", cPost)).toBe(false);
    expect(invoiceIdMatches(invoiceId, cPost)).toBe(true);
    expect(invoiceIdMatches(invoiceId, cPre)).toBe(false);
  });

  it("rejects malformed anchors", () => {
    expect(() => toCustomId("AB12", commitPre(hW, hC, hP))).toThrow(TypeError);
    expect(parseCustomId("writ:ab12cd34:xyz")).toBeNull();
    expect(parseInvoiceId("wv-123")).toBeNull();
    expect(customIdMatches("nope", "ab12cd34", hW)).toBe(false);
    expect(invoiceIdMatches("nope", hW)).toBe(false);
  });
});
