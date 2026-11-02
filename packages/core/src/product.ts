// Typed product data. CatalogItem is what the gateway resolves a product_ref to (Channel3 search
// results and the Deals Outlet fixture catalog): carts are built from it, never from agent claims,
// so an agent cannot relabel a protection plan as pottery. ProductFacts is what Scout's quarantined
// Reader extracts from a raw page and what the Verifier reads instead of the page (plan §8.3, §8.5).
import { z } from "zod";
import { ProductRefSchema } from "./cart";
import { MerchantIdSchema, HttpUrlSchema } from "./ids";
import { CurrencySchema, MinorAmountSchema } from "./money";
import { CategoryLeafSchema, ItemKindSchema } from "./taxonomy";
import { IsoDateSchema, singleLineText } from "./writ";

// A scheme, "www.", or a bare domain with a common TLD: quarantined facts never carry a link.
const URL_LIKE_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|shop|store|app|xyz|info|biz|us|uk|in)\b)/i;
const EMAIL_LIKE_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** singleLineText that also refuses URLs and email addresses (plan §8.3: no URLs/emails in Reader strings). */
export function factText(max: number) {
  return singleLineText(max)
    .refine((text) => !URL_LIKE_RE.test(text), "URLs are not allowed")
    .refine((text) => !EMAIL_LIKE_RE.test(text), "email addresses are not allowed");
}

export const CATALOG_SOURCES = ["channel3", "fixture"] as const;
export const CatalogSourceSchema = z.enum(CATALOG_SOURCES);
export type CatalogSource = z.infer<typeof CatalogSourceSchema>;

export const CatalogItemSchema = z.strictObject({
  product_ref: ProductRefSchema,
  source: CatalogSourceSchema,
  /** UNTRUSTED merchant text: display only, datamarked before any prompt (§22 rule 16). */
  title: singleLineText(200),
  merchant_id: MerchantIdSchema,
  merchant_name: singleLineText(80).nullable(),
  /** Mapped deterministically to the fixed taxonomy; null = unmapped, and an unmapped item cannot be carted. */
  category: CategoryLeafSchema.nullable(),
  kind: ItemKindSchema,
  price_minor: MinorAmountSchema,
  currency: CurrencySchema,
  /** Delivery estimate in days from today. Simulated in sandbox ("simulated fulfillment"). */
  eta_days: z.int().min(0).max(365).nullable(),
  url: HttpUrlSchema.max(2048).nullable(),
  image_url: HttpUrlSchema.max(2048).nullable(),
});
export type CatalogItem = z.infer<typeof CatalogItemSchema>;

export const FIXTURE_CATALOG_SPEC = "writ-fixture-catalog/0.1";

/**
 * fixtures/<site>/catalog.json: the products a security test fixture site offers. Labeled and
 * never presented as real merchant data (§22 rules 22 and 25).
 */
export const FixtureCatalogSchema = z
  .strictObject({
    spec: z.literal(FIXTURE_CATALOG_SPEC),
    label: z.literal("security test fixture"),
    site: MerchantIdSchema,
    items: z.array(CatalogItemSchema).max(200),
  })
  .refine((catalog) => catalog.items.every((item) => item.source === "fixture"), {
    message: "fixture catalog items must have source 'fixture'",
    path: ["items"],
  })
  .refine((catalog) => new Set(catalog.items.map((item) => item.product_ref)).size === catalog.items.length, {
    message: "product_ref must be unique",
    path: ["items"],
  });
export type FixtureCatalog = z.infer<typeof FixtureCatalogSchema>;

/**
 * Scout's quarantined Reader output: numbers, enums and short strings only. Strict, so an injected
 * field forces a repair retry; strings refuse URLs and emails so nothing actionable crosses over.
 */
export const ProductFactsSchema = z.strictObject({
  product_ref: ProductRefSchema,
  title: factText(80),
  merchant_id: MerchantIdSchema.nullable(),
  category: CategoryLeafSchema.nullable(),
  kind: ItemKindSchema,
  price_minor: MinorAmountSchema.nullable(),
  currency: CurrencySchema.nullable(),
  eta: IsoDateSchema.nullable(),
  /** Short descriptive attributes the Verifier may weigh (material, style, "hand-thrown", "set of 2"). */
  attributes: z.array(factText(80)).max(8),
  /** What the page pushes, as booleans only: the Planner learns that a page tries, never what it says. */
  signals: z.strictObject({
    pushes_add_on: z.boolean(),
    pushes_shipping_change: z.boolean(),
    pushes_payment_change: z.boolean(),
  }),
});
export type ProductFacts = z.infer<typeof ProductFactsSchema>;
