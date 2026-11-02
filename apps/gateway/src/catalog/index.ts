// Product data for carts (P0-3). Carts are built from catalog_items, never from agent claims, so an
// agent cannot relabel a protection plan as pottery or name its own price (threats T1, T4). Channel3 is
// the real source; the Deals Outlet fixture is the labeled security test catalog (§22 rules 22, 25).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORY_LEAVES, CatalogItemSchema, FixtureCatalogSchema, minorToString, parseMinor, type CatalogItem, type CategoryLeaf, type JsonValue } from "@writ/core";
import { slugify, summarizeProduct } from "@writ/ai";
import type { AgentSearchRequest, AgentSearchResponse } from "@writ/core/api";
import { and, eq, inArray } from "drizzle-orm";
import { FIXTURES_DIR } from "../config";
import type { Db } from "../db/client";
import { catalogItems, type CatalogItemRow } from "../db/schema";
import type { CoreServices } from "../deps";

const FIXTURE_SITES = ["deals-outlet"];

let fixtureCache: CatalogItem[] | null = null;

/** Fixture URLs are stored relative to the Wallet origin so the same file works locally and on Render. */
function loadFixtureItems(appBaseUrl: string | null): CatalogItem[] {
  if (fixtureCache !== null) return fixtureCache;
  const items: CatalogItem[] = [];
  for (const site of FIXTURE_SITES) {
    try {
      const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, site, "catalog.json"), "utf8")) as { items?: { url?: string | null }[] };
      const origin = appBaseUrl ?? "http://localhost:3000";
      for (const item of raw.items ?? []) {
        if (typeof item.url === "string" && item.url.startsWith("/")) item.url = `${origin}${item.url}`;
      }
      items.push(...FixtureCatalogSchema.parse(raw).items);
    } catch (error) {
      // No fixture catalog on disk: search simply has no fixture results. A broken one must not be silent.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  fixtureCache = items;
  return items;
}

const CATEGORY_KEYWORDS: readonly [RegExp, CategoryLeaf][] = [
  [/pour.?over|coffee|tea\b|teapot|french press/i, "home_kitchen.coffee_tea"],
  [/mug|cup|tumbler|drinkware/i, "home_kitchen.drinkware"],
  [/plate|bowl|dinnerware|tableware/i, "home_kitchen.tableware"],
  [/pottery|ceramic|stoneware|porcelain|hand.?thrown/i, "arts_crafts.pottery_ceramics"],
];

/** Deterministic only: an item that maps to nothing stays unmapped and cannot be carted. */
export function mapCategory(texts: readonly (string | null | undefined)[]): CategoryLeaf | null {
  const joined = texts.filter((text): text is string => typeof text === "string").join(" ");
  for (const [pattern, leaf] of CATEGORY_KEYWORDS) if (pattern.test(joined) && (CATEGORY_LEAVES as readonly string[]).includes(leaf)) return leaf;
  return null;
}

function rowToItem(row: CatalogItemRow): CatalogItem {
  return CatalogItemSchema.parse({
    product_ref: row.productRef,
    source: row.source,
    title: row.title,
    merchant_id: row.merchantId,
    merchant_name: row.merchantName,
    category: row.category,
    kind: row.kind,
    price_minor: minorToString(row.priceMinor),
    currency: row.currency,
    eta_days: row.etaDays,
    url: row.url,
    image_url: row.imageUrl,
  });
}

async function remember(deps: Pick<CoreServices, "ids">, db: Db, tenantId: string, items: readonly CatalogItem[], raw: ReadonlyMap<string, JsonValue>): Promise<void> {
  for (const item of items) {
    const values = {
      source: item.source,
      title: item.title,
      merchantId: item.merchant_id,
      merchantName: item.merchant_name,
      category: item.category,
      kind: item.kind,
      priceMinor: parseMinor(item.price_minor),
      currency: item.currency,
      etaDays: item.eta_days,
      url: item.url,
      imageUrl: item.image_url,
      raw: raw.get(item.product_ref) ?? {},
    };
    await db
      .insert(catalogItems)
      .values({ id: deps.ids("catalogItem"), tenantId, productRef: item.product_ref, ...values })
      .onConflictDoUpdate({ target: [catalogItems.tenantId, catalogItems.productRef], set: values });
  }
}

function matchesFixture(item: CatalogItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
  const title = item.title.toLowerCase();
  return words.length === 0 || words.some((word) => title.includes(word));
}

export async function searchCatalog(deps: CoreServices, db: Db, tenantId: string, request: AgentSearchRequest): Promise<AgentSearchResponse> {
  const limit = request.limit ?? 10;
  const withinPrice = (item: CatalogItem): boolean => request.max_price_minor === undefined || parseMinor(item.price_minor) <= parseMinor(request.max_price_minor);
  const inCategory = (item: CatalogItem): boolean => request.category === undefined || item.category === request.category;
  const fixtures = loadFixtureItems(deps.config.appBaseUrl).filter((item) => matchesFixture(item, request.query) && withinPrice(item) && inCategory(item));

  const real: CatalogItem[] = [];
  const raw = new Map<string, JsonValue>();
  if (deps.channel3 !== null) {
    const outcome = await deps.channel3.search({ query: request.query, limit });
    for (const product of outcome.parsed?.products ?? []) {
      const summary = summarizeProduct(product);
      if (summary.priceMinor === null || summary.currency !== "USD") continue;
      const parsed = CatalogItemSchema.safeParse({
        product_ref: `ch3_${summary.id}`.slice(0, 128),
        source: "channel3",
        title: summary.title.replace(/\s+/g, " ").slice(0, 200),
        merchant_id: slugify(summary.merchant ?? "unknown-merchant").slice(0, 64) || "unknown-merchant",
        merchant_name: summary.merchant?.slice(0, 80) ?? null,
        category: mapCategory([summary.category, summary.categoryPath, summary.title]),
        kind: "goods",
        price_minor: minorToString(summary.priceMinor),
        currency: "USD",
        eta_days: 7, // Delivery is simulated in sandbox ("simulated fulfillment").
        url: summary.url,
        image_url: summary.imageUrl,
      });
      if (parsed.success && withinPrice(parsed.data) && inCategory(parsed.data)) {
        real.push(parsed.data);
        raw.set(parsed.data.product_ref, product as unknown as JsonValue);
      }
    }
  }
  const results = [...real, ...fixtures].slice(0, limit);
  await remember(deps, db, tenantId, results, raw);
  if (deps.channel3 === null) {
    return {
      source: fixtures.length > 0 ? "fixture" : "unavailable",
      results,
      notice: fixtures.length > 0 ? "Channel3 is not configured; showing security test fixture products." : "Channel3 is not configured and no fixture matched.",
    };
  }
  return { source: "channel3", results, notice: null };
}

/** Known products, resolved inside the tenant; a fixture product is found even before anyone searched for it. */
export async function resolveProducts(deps: CoreServices, db: Db, tenantId: string, refs: readonly string[]): Promise<Map<string, CatalogItem>> {
  const rows = refs.length === 0 ? [] : await db.select().from(catalogItems).where(and(eq(catalogItems.tenantId, tenantId), inArray(catalogItems.productRef, [...refs])));
  const found = new Map(rows.map((row) => [row.productRef, rowToItem(row)]));
  const missing = refs.filter((ref) => !found.has(ref));
  if (missing.length > 0) {
    const fixtures = loadFixtureItems(deps.config.appBaseUrl).filter((item) => missing.includes(item.product_ref));
    await remember(deps, db, tenantId, fixtures, new Map());
    for (const item of fixtures) found.set(item.product_ref, item);
  }
  return found;
}
