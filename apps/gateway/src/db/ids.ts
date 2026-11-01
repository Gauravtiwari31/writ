// App-generated primary keys are @writ/core ids: "<prefix>_<26-char ULID>" (48-bit ms time, then
// 80 random bits). Writ and cart bodies validate writ_id, agent_id, cart_id, user_id and ship_to_ref
// with core's idSchema, so rows that a signed document can reference MUST use core's prefixes, or
// the gateway would mint ids its own contracts reject. Rows that never appear in a signed document
// get gateway-local prefixes on the same ULID body (time-ordered, so inserts stay index-local).
import { type Clock, type IdPrefix, isId as isCoreId, newId as newCoreId } from "@writ/core";

const CORE_ROW_PREFIXES = {
  user: "usr",
  address: "adr",
  agent: "agt",
  writ: "wr",
  cart: "crt",
  purchase: "pur",
  approval: "apr",
} as const satisfies Record<string, IdPrefix>;

const LOCAL_ROW_PREFIXES = {
  passkey: "psk",
  deviceKey: "dvk",
  vaultToken: "vlt",
  decision: "dec",
  dispute: "dsp",
  attack: "atk",
  outbox: "obx",
} as const;

export const ROW_ID_PREFIXES = { ...CORE_ROW_PREFIXES, ...LOCAL_ROW_PREFIXES } as const;
export type RowKind = keyof typeof ROW_ID_PREFIXES;

type CoreRowKind = keyof typeof CORE_ROW_PREFIXES;
type LocalRowKind = keyof typeof LOCAL_ROW_PREFIXES;

// Local ids take their ULID body from a core id so the encoding lives in exactly one place.
const BODY_DONOR: IdPrefix = "usr";
const DONOR_HEAD = `${BODY_DONOR}_`;

function isCoreRowKind(kind: RowKind): kind is CoreRowKind {
  return Object.hasOwn(CORE_ROW_PREFIXES, kind);
}

function localPrefix(kind: LocalRowKind): string {
  return `${LOCAL_ROW_PREFIXES[kind]}_`;
}

/** A fresh primary key for a `kind` row. `clock` is injectable for deterministic tests and replays. */
export function newRowId(kind: RowKind, clock?: Clock): string {
  if (isCoreRowKind(kind)) return newCoreId(CORE_ROW_PREFIXES[kind], clock);
  return localPrefix(kind) + newCoreId(BODY_DONOR, clock).slice(DONOR_HEAD.length);
}

/** True when `value` has the shape newRowId(kind) produces; check before trusting an id from a URL or body. */
export function isRowId(kind: RowKind, value: string): boolean {
  if (isCoreRowKind(kind)) return isCoreId(CORE_ROW_PREFIXES[kind], value);
  const prefix = localPrefix(kind);
  return value.startsWith(prefix) && isCoreId(BODY_DONOR, DONOR_HEAD + value.slice(prefix.length));
}
