// Money is integer minor units (bigint) end to end (§22 rule 13). Signed documents carry
// minor units as decimal strings ("6000") so no language ever parses them as floats.
import { z } from "zod";

export const CURRENCY_EXPONENT = { USD: 2 } as const;
export type Currency = keyof typeof CURRENCY_EXPONENT;
export const CurrencySchema = z.enum(["USD"]);

/** Max 16 digits keeps every amount far inside Postgres BIGINT and JS safe-integer range. */
const MINOR_RE = /^(0|[1-9][0-9]{0,15})$/;

export const MinorAmountSchema = z.string().regex(MINOR_RE, "minor units as a non-negative integer string");
export type MinorAmount = z.infer<typeof MinorAmountSchema>;

export function parseMinor(amount: string): bigint {
  if (!MINOR_RE.test(amount)) throw new TypeError(`invalid minor amount: ${JSON.stringify(amount)}`);
  return BigInt(amount);
}

export function minorToString(minor: bigint): MinorAmount {
  if (minor < 0n) throw new RangeError("minor amounts are non-negative");
  const text = minor.toString();
  if (!MINOR_RE.test(text)) throw new RangeError("minor amount out of range");
  return text;
}

/** 4400n USD → "44.00" (the PayPal API `value` format). */
export function minorToPayPalValue(minor: bigint, currency: Currency): string {
  if (minor < 0n) throw new RangeError("PayPal values are non-negative");
  const exponent: number = CURRENCY_EXPONENT[currency];
  if (exponent === 0) return minor.toString();
  const digits = minor.toString().padStart(exponent + 1, "0");
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/** "44.00" USD → 4400n. Strict: exactly the currency's number of decimals, or none. */
export function payPalValueToMinor(value: string, currency: Currency): bigint {
  const exponent = CURRENCY_EXPONENT[currency];
  const match = /^(0|[1-9][0-9]{0,13})(?:\.([0-9]+))?$/.exec(value);
  if (!match) throw new TypeError(`invalid PayPal value: ${JSON.stringify(value)}`);
  const whole = match[1] as string;
  const fraction = match[2] ?? "";
  if (fraction.length !== 0 && fraction.length !== exponent) {
    throw new TypeError(`PayPal value ${value} must have ${exponent} decimals for ${currency}`);
  }
  return BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fraction === "" ? "0" : fraction);
}
