// The typed cart an agent proposes against a Writ (plan §6.2 stage 1). There is deliberately no
// payee field anywhere: the payee is always the merchant of record, and the strict schema rejects
// any attempt to name one (threat T3).
import { z } from "zod";
import { hashJcs, hashJcsHex } from "./hash";
import { idSchema, MerchantIdSchema, HttpUrlSchema } from "./ids";
import { CurrencySchema, MinorAmountSchema, parseMinor } from "./money";
import { CategoryLeafSchema, ItemKindSchema } from "./taxonomy";
import { IsoDateSchema, IsoTimestampSchema, singleLineText } from "./writ";

export const CART_SPEC = "writ-cart/0.1";

/** Opaque catalog reference (e.g. a Channel3 product id): printable ASCII, no spaces. */
export const ProductRefSchema = z.string().regex(/^[\x21-\x7e]{1,128}$/, "product_ref: 1-128 printable ASCII chars");
export type ProductRef = z.infer<typeof ProductRefSchema>;

export const CartItemSchema = z.strictObject({
  product_ref: ProductRefSchema,
  /** UNTRUSTED merchant text: display only, datamarked before any prompt (§22 rule 16). */
  title: singleLineText(200),
  merchant_id: MerchantIdSchema,
  category: CategoryLeafSchema,
  kind: ItemKindSchema,
  unit_minor: MinorAmountSchema,
  qty: z.int().min(1).max(99),
});
export type CartItem = z.infer<typeof CartItemSchema>;

function lineTotal(item: Pick<CartItem, "unit_minor" | "qty">): bigint {
  return parseMinor(item.unit_minor) * BigInt(item.qty);
}

export interface CartAmounts {
  items: readonly Pick<CartItem, "unit_minor" | "qty">[];
  shipping_minor: string;
  tax_minor: string;
}

/** Sum of unit × qty, plus shipping and tax, in bigint minor units. */
export function computeCartTotal(cart: CartAmounts): bigint {
  let total = parseMinor(cart.shipping_minor) + parseMinor(cart.tax_minor);
  for (const item of cart.items) total += lineTotal(item);
  return total;
}

export const CartSchema = z
  .strictObject({
    spec: z.literal(CART_SPEC),
    cart_id: idSchema("crt"),
    writ_id: idSchema("wr"),
    agent_id: idSchema("agt"),
    currency: CurrencySchema,
    items: z.array(CartItemSchema).min(1).max(20),
    shipping_minor: MinorAmountSchema,
    tax_minor: MinorAmountSchema,
    /** Declared by the proposer; must equal computeCartTotal, which is what PayPal is asked for. */
    total_minor: MinorAmountSchema,
    ship_to_ref: idSchema("adr"),
    eta: IsoDateSchema.nullable(),
  })
  .superRefine((cart, ctx) => {
    const refs = new Set<string>();
    cart.items.forEach((item, i) => {
      if (refs.has(item.product_ref)) {
        ctx.addIssue({ code: "custom", path: ["items", i, "product_ref"], message: "one line per product; use qty" });
      }
      refs.add(item.product_ref);
    });
    // Zod still runs this after continuable field issues (e.g. qty 120), so compare only when every
    // amount parsed and every qty is an integer BigInt can take.
    const amounts = [cart.shipping_minor, cart.tax_minor, cart.total_minor, ...cart.items.map((item) => item.unit_minor)];
    const quantitiesOk = cart.items.every((item) => Number.isSafeInteger(item.qty));
    if (quantitiesOk && amounts.every((amount) => MinorAmountSchema.safeParse(amount).success)) {
      if (computeCartTotal(cart) !== parseMinor(cart.total_minor)) {
        ctx.addIssue({ code: "custom", path: ["total_minor"], message: "declared total does not match items + shipping + tax" });
      }
    }
  });
export type Cart = z.infer<typeof CartSchema>;

/** H_c = sha256(JCS(cart)) (plan §6.7). */
export function cartHash(cart: Cart): Uint8Array {
  return hashJcs(cart);
}

export function cartHashHex(cart: Cart): string {
  return hashJcsHex(cart);
}

/**
 * A tainted input that influenced a cart (plan §6.5 carts.sources). Kept beside the cart, never in
 * it: the Sentinel scans these, the Verifier only ever sees the resulting flags.
 */
export const CartSourceSchema = z.strictObject({
  url: HttpUrlSchema.max(2048),
  kind: z.enum(["page", "search_result", "listing"]),
  fetched_at: IsoTimestampSchema,
  /**
   * Optional extension: the cart line this source fed, so a Sentinel flag can be pinned to an item.
   * Absent or null = it shaped the whole cart (e.g. a coupon page). Sources are not part of H_c,
   * so accepting both spellings cannot split a commitment.
   */
  product_ref: ProductRefSchema.nullish(),
});
export type CartSource = z.infer<typeof CartSourceSchema>;

export const CartSourcesSchema = z.array(CartSourceSchema).max(50);
