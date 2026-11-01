// Channel3 product search (the agents' search_products tool, plan §5 P0-3).
// Request shape follows the OpenAPI reference: POST https://api.trychannel3.com/v1/search with
// x-api-key. Responses are parsed loosely; prices arrive as decimal numbers and are converted
// to integer minor units here, at the edge (§22 rule 13).
import { z } from "zod";
import { safeErrorText } from "./redact";
import type { FetchLike } from "./catalog";

export const CHANNEL3_BASE_URL = "https://api.trychannel3.com";
export const CHANNEL3_SEARCH_PATH = "/v1/search";
/** Documented maximum `limit` for /v1/search. */
export const CHANNEL3_MAX_LIMIT = 30;

export type Channel3Availability = "InStock" | "OutOfStock";

export interface Channel3SearchRequest {
  query: string;
  limit?: number;
  filters?: {
    price?: { min_price?: number; max_price?: number };
    availability?: Channel3Availability[];
    exclude_brand_ids?: string[];
    category_ids?: string[];
  };
  config?: { mode?: "default" | "keyword" | "agentic"; country?: string; currency?: string };
}

// The docs show the offer price both as {price, currency} (OpenAPI) and {amount, currency}
// (guide examples), so both are accepted and the shape seen is reported.
const Channel3Price = z.looseObject({
  price: z.number().nullish(),
  amount: z.number().nullish(),
  compare_at_price: z.number().nullish(),
  currency: z.string().nullish(),
});

const Channel3Offer = z.looseObject({
  url: z.string().nullish(),
  domain: z.string().nullish(),
  price: Channel3Price.nullish(),
  availability: z.string().nullish(),
  condition: z.string().nullish(),
});

const Channel3Image = z.looseObject({
  url: z.string().nullish(),
  cleaned_url: z.string().nullish(),
  is_main_image: z.boolean().nullish(),
});

const Channel3Category = z.looseObject({
  slug: z.string().nullish(),
  title: z.string().nullish(),
  path: z.array(z.looseObject({ slug: z.string().nullish(), title: z.string().nullish() })).nullish(),
});

export const Channel3ProductSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  brands: z.array(z.looseObject({ id: z.string().nullish(), name: z.string().nullish() })).nullish(),
  images: z.array(Channel3Image).nullish(),
  category: Channel3Category.nullish(),
  offers: z.array(Channel3Offer).nullish(),
});
export type Channel3Product = z.infer<typeof Channel3ProductSchema>;

export const Channel3SearchResponseSchema = z.looseObject({
  products: z.array(Channel3ProductSchema),
  next_page_token: z.string().nullish(),
});
export type Channel3SearchResponse = z.infer<typeof Channel3SearchResponseSchema>;

export interface Channel3SearchOutcome {
  status: number | undefined;
  latencyMs: number;
  /** Raw JSON body (or text when not JSON); kept for the cached-snapshot fallback. */
  raw: unknown;
  parsed?: Channel3SearchResponse;
  error?: string;
  retryAfterSec?: number;
}

export interface Channel3SearchOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export function buildChannel3SearchBody(request: Channel3SearchRequest): Channel3SearchRequest {
  const query = request.query.trim();
  if (query === "") throw new RangeError("Channel3 search query must be non-empty");
  const limit = request.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CHANNEL3_MAX_LIMIT) {
    throw new RangeError(`Channel3 limit must be an integer between 1 and ${CHANNEL3_MAX_LIMIT}`);
  }
  return { ...request, query, limit };
}

export async function channel3Search(
  apiKey: string,
  request: Channel3SearchRequest,
  options: Channel3SearchOptions = {},
): Promise<Channel3SearchOutcome> {
  const body = buildChannel3SearchBody(request);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl ?? CHANNEL3_BASE_URL}${CHANNEL3_SEARCH_PATH}`;
  const started = performance.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
  } catch (error) {
    return {
      status: undefined,
      latencyMs: performance.now() - started,
      raw: null,
      error: `request failed: ${safeErrorText(String(error))}`,
    };
  }
  const text = await response.text();
  const latencyMs = performance.now() - started;
  let raw: unknown = text;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    // keep the text; it is reported below
  }
  const retryAfter = Number(response.headers.get("retry-after"));
  const retry = Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSec: retryAfter } : {};
  if (!response.ok) {
    return {
      status: response.status,
      latencyMs,
      raw,
      error: `HTTP ${response.status}: ${safeErrorText(typeof raw === "string" ? raw : JSON.stringify(raw), 240)}`,
      ...retry,
    };
  }
  const parsed = Channel3SearchResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: response.status, latencyMs, raw, error: `unexpected response shape: ${parsed.error.message.slice(0, 240)}` };
  }
  return { status: response.status, latencyMs, raw, parsed: parsed.data };
}

/** Decimal price → integer minor units for 2-decimal currencies (every currency Channel3 lists). */
export function decimalPriceToMinor(price: number): bigint | null {
  if (!Number.isFinite(price) || price < 0) return null;
  const [whole, fraction = ""] = price.toFixed(2).split(".");
  if (whole === undefined) return null;
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

export interface ProductSummary {
  id: string;
  title: string;
  brand: string | null;
  merchant: string | null;
  category: string | null;
  categoryPath: string | null;
  price: number | null;
  priceMinor: bigint | null;
  currency: string | null;
  /** Which documented price shape the offer used. */
  priceField: "price" | "amount" | null;
  availability: string | null;
  imageUrl: string | null;
  url: string | null;
  complete: boolean;
}

function offerPrice(offer: z.infer<typeof Channel3Offer>): { value: number; field: "price" | "amount" } | null {
  const price = offer.price;
  if (price == null) return null;
  if (typeof price.price === "number") return { value: price.price, field: "price" };
  if (typeof price.amount === "number") return { value: price.amount, field: "amount" };
  return null;
}

/** Picks the cheapest in-stock offer (falling back to the first priced offer) and flattens the fields we show. */
export function summarizeProduct(product: Channel3Product): ProductSummary {
  const offers = product.offers ?? [];
  const priced = offers
    .map((offer) => ({ offer, price: offerPrice(offer) }))
    .filter((entry): entry is { offer: (typeof offers)[number]; price: { value: number; field: "price" | "amount" } } => entry.price !== null);
  const inStock = priced.filter((entry) => entry.offer.availability !== "OutOfStock");
  const pool = inStock.length > 0 ? inStock : priced;
  const best = pool.reduce<(typeof pool)[number] | undefined>(
    (min, entry) => (min === undefined || entry.price.value < min.price.value ? entry : min),
    undefined,
  );
  const offer = best?.offer ?? offers[0];
  const images = product.images ?? [];
  const mainImage = images.find((image) => image.is_main_image === true) ?? images[0];
  const imageUrl = mainImage?.cleaned_url ?? mainImage?.url ?? null;
  const path = product.category?.path
    ?.map((ref) => ref.title ?? ref.slug)
    .filter((part): part is string => typeof part === "string" && part !== "");
  const summary: ProductSummary = {
    id: product.id,
    title: product.title,
    brand: product.brands?.find((brand) => typeof brand.name === "string" && brand.name !== "")?.name ?? null,
    merchant: offer?.domain ?? null,
    category: product.category?.title ?? product.category?.slug ?? null,
    categoryPath: path !== undefined && path.length > 0 ? path.join(" > ") : null,
    price: best?.price.value ?? null,
    priceMinor: best === undefined ? null : decimalPriceToMinor(best.price.value),
    currency: offer?.price?.currency ?? null,
    priceField: best?.price.field ?? null,
    availability: offer?.availability ?? null,
    imageUrl,
    url: offer?.url ?? null,
    complete: false,
  };
  summary.complete =
    summary.price !== null &&
    summary.currency !== null &&
    summary.imageUrl !== null &&
    summary.merchant !== null &&
    summary.category !== null &&
    summary.url !== null;
  return summary;
}

/**
 * Obvious big brands. The hero video must not show third-party marks (§22 rule 36), and the
 * story needs unbranded handmade goods, so these get flagged. Brands that are also everyday
 * words (Apple, Target, Staples, Fiesta) are left out to avoid flagging "apple green mug".
 */
export const BIG_BRANDS: readonly string[] = [
  "Amazon Basics",
  "Anthropologie",
  "Avery",
  "BIC",
  "Corelle",
  "Crate & Barrel",
  "Disney",
  "Hallmark",
  "Hammermill",
  "HP",
  "IKEA",
  "Kate Spade",
  "Le Creuset",
  "Lenox",
  "Marvel",
  "Nike",
  "Paper Mate",
  "Pilot",
  "Post-it",
  "Pottery Barn",
  "Pyrex",
  "Rae Dunn",
  "Samsung",
  "Sharpie",
  "Starbucks",
  "Walmart",
  "West Elm",
  "Williams Sonoma",
  "Yeti",
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns the first big-brand name found as a whole word in any of the texts. */
export function findBigBrand(texts: ReadonlyArray<string | null | undefined>, brands: readonly string[] = BIG_BRANDS): string | null {
  for (const brand of brands) {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(brand.toLowerCase())}($|[^a-z0-9])`, "i");
    if (texts.some((text) => typeof text === "string" && pattern.test(text))) return brand;
  }
  return null;
}

const HANDMADE_WORDS = /hand[\s-]?(made|thrown|crafted|built|painted|glazed)|artisan|studio pottery|wheel[\s-]thrown/i;

export function looksHandmade(texts: ReadonlyArray<string | null | undefined>): boolean {
  return texts.some((text) => typeof text === "string" && HANDMADE_WORDS.test(text));
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "query"
  );
}
