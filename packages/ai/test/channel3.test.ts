import { describe, expect, it } from "vitest";
import {
  buildChannel3SearchBody,
  CHANNEL3_BASE_URL,
  channel3Search,
  Channel3SearchResponseSchema,
  decimalPriceToMinor,
  findBigBrand,
  looksHandmade,
  slugify,
  summarizeProduct,
  type FetchLike,
} from "../src/index";

// Shaped after the /v1/search OpenAPI reference (https://channel3.mintlify.dev/docs/api-reference/v1/search.md).
const product = {
  id: "p1",
  title: "Hand-thrown stoneware mug",
  brands: [{ id: "b1", name: "Small Studio" }],
  images: [
    { url: "https://img.test/side.jpg", is_main_image: false },
    { url: "https://img.test/main.jpg", cleaned_url: "https://cdn.test/main.png", is_main_image: true },
  ],
  category: { slug: "mugs", title: "Mugs", path: [{ slug: "kitchen", title: "Kitchen" }, { slug: "mugs", title: "Mugs" }], has_children: false },
  offers: [
    { url: "https://buy.test/a", domain: "shop-a.test", price: { price: 48, currency: "USD" }, availability: "InStock" },
    { url: "https://buy.test/b", domain: "shop-b.test", price: { price: 39.99, compare_at_price: 45, currency: "USD" }, availability: "InStock" },
    { url: "https://buy.test/c", domain: "shop-c.test", price: { price: 10, currency: "USD" }, availability: "OutOfStock" },
  ],
  unknown_future_field: { x: 1 },
};

describe("summarizeProduct", () => {
  it("picks the cheapest in-stock offer and the main cleaned image", () => {
    const summary = summarizeProduct(Channel3SearchResponseSchema.parse({ products: [product] }).products[0]!);
    expect(summary).toEqual({
      id: "p1",
      title: "Hand-thrown stoneware mug",
      brand: "Small Studio",
      merchant: "shop-b.test",
      category: "Mugs",
      categoryPath: "Kitchen > Mugs",
      price: 39.99,
      priceMinor: 3999n,
      currency: "USD",
      priceField: "price",
      availability: "InStock",
      imageUrl: "https://cdn.test/main.png",
      url: "https://buy.test/b",
      complete: true,
    });
  });

  it("accepts the {amount, currency} price shape shown in the guides", () => {
    const summary = summarizeProduct({
      id: "p2",
      title: "Vase",
      offers: [{ url: "https://buy.test/v", domain: "v.test", price: { amount: 44, currency: "USD" }, availability: "InStock" }],
    });
    expect(summary.priceMinor).toBe(4400n);
    expect(summary.priceField).toBe("amount");
    expect(summary.complete).toBe(false); // no image, no category
  });

  it("is incomplete when there are no offers", () => {
    const summary = summarizeProduct({ id: "p3", title: "Bowl", offers: [], images: [{ url: "https://img.test/x.jpg" }] });
    expect(summary).toMatchObject({ price: null, merchant: null, url: null, imageUrl: "https://img.test/x.jpg", complete: false });
  });
});

describe("decimalPriceToMinor", () => {
  it.each([
    [19.99, 1999n],
    [0.1 + 0.2, 30n],
    [60, 6000n],
    [0, 0n],
  ] as const)("%f → %s", (price, minor) => {
    expect(decimalPriceToMinor(price)).toBe(minor);
  });

  it("rejects negative and non-finite prices", () => {
    expect(decimalPriceToMinor(-1)).toBeNull();
    expect(decimalPriceToMinor(Number.NaN)).toBeNull();
  });
});

describe("brand and handmade checks", () => {
  it("flags big brands as whole words in title or brand", () => {
    expect(findBigBrand(["Pottery Barn Stoneware Mug"])).toBe("Pottery Barn");
    expect(findBigBrand(["Blue mug", "Le Creuset"])).toBe("Le Creuset");
    expect(findBigBrand(["Hand-thrown pottery vase", "Small Studio"])).toBeNull();
    expect(findBigBrand(["Graphpaper notebook"])).toBeNull(); // "HP" must not match inside a word
    expect(findBigBrand(["HP Printer Paper, 500 sheets"])).toBe("HP");
  });

  it("recognizes handmade wording", () => {
    expect(looksHandmade(["Hand thrown ceramic mug"])).toBe(true);
    expect(looksHandmade(["Artisan stoneware bowl"])).toBe(true);
    expect(looksHandmade(["Ceramic mug, dishwasher safe"])).toBe(false);
  });

  it("slugifies queries for snapshot file names", () => {
    expect(slugify("Ceramic mug set gift under $40!")).toBe("ceramic-mug-set-gift-under-40");
    expect(slugify("!!!")).toBe("query");
  });
});

describe("channel3Search", () => {
  it("validates the request body", () => {
    expect(() => buildChannel3SearchBody({ query: "  " })).toThrow(RangeError);
    expect(() => buildChannel3SearchBody({ query: "mug", limit: 31 })).toThrow(RangeError);
    expect(buildChannel3SearchBody({ query: " mug " })).toEqual({ query: "mug", limit: 10 });
  });

  it("posts JSON with x-api-key and parses the response", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ products: [product], next_page_token: null }), { status: 200 });
    };
    const outcome = await channel3Search("c3-key", { query: "mug", limit: 3, filters: { price: { max_price: 60 } } }, { fetchImpl });
    expect(outcome.status).toBe(200);
    expect(outcome.parsed?.products).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${CHANNEL3_BASE_URL}/v1/search`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]?.init?.headers as Record<string, string>)["x-api-key"]).toBe("c3-key");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ query: "mug", limit: 3, filters: { price: { max_price: 60 } } });
  });

  it("reports HTTP errors with Retry-After", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ detail: "Too Many Requests" }), { status: 429, headers: { "retry-after": "5" } });
    const outcome = await channel3Search("k", { query: "mug" }, { fetchImpl });
    expect(outcome).toMatchObject({ status: 429, retryAfterSec: 5 });
    expect(outcome.error).toContain("HTTP 429");
    expect(outcome.parsed).toBeUndefined();
  });

  it("reports an unexpected shape instead of throwing", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ items: [] }), { status: 200 });
    const outcome = await channel3Search("k", { query: "mug" }, { fetchImpl });
    expect(outcome.error).toContain("unexpected response shape");
  });
});
