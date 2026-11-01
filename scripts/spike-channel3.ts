// Spike S7 (plan §17): does Channel3 fit the hero?
//
//   pnpm spike spike-channel3.ts [--limit 10] [--results 10] [--delay-ms 400] [--query "..."] [--dry-run]
//
// Runs the hero queries against POST https://api.trychannel3.com/v1/search (1 credit each; credits
// are finite, so --limit runs only the first N queries). Prints per query: result count, latency
// and the top 3 products (title, price, currency, merchant, category, image, URL), flags obvious
// big brands, saves every raw response to scripts/.out/channel3/<slug>.json (the §17 cached-snapshot
// fallback) and a summary to scripts/.out/channel3/summary.json.
// PASS: ≥ 80% of queries return a product with price, image, merchant, category and URL, and at
// least one hero query yields an unbranded, handmade-looking, complete option within its budget.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  buildChannel3SearchBody,
  CHANNEL3_BASE_URL,
  CHANNEL3_MAX_LIMIT,
  CHANNEL3_SEARCH_PATH,
  channel3Search,
  findBigBrand,
  looksHandmade,
  safeErrorText,
  slugify,
  summarizeProduct,
  type Channel3SearchRequest,
  type ProductSummary,
} from "@writ/ai";
import { describeEnv, optionalEnv, REPO_ROOT } from "./lib/env";
import { OUT_DIR, writeOut } from "./lib/out";

const ENV_FILE = resolve(REPO_ROOT, ".env");
const USAGE = `Usage:
  pnpm spike spike-channel3.ts [--limit 10] [--results 10] [--delay-ms 400] [--query "<text>"] [--dry-run]
Needs CHANNEL3_API_KEY in ${ENV_FILE}. Each query costs 1 Channel3 credit.`;

class UsageError extends Error {}
class ConfigError extends Error {}

interface HeroQuery {
  query: string;
  /** Budget ceiling in dollars, sent as filters.price.max_price (inclusive per the API reference). */
  maxPrice?: number;
  /** Hero (pottery gift) queries must surface unbranded handmade goods; office ones need not. */
  hero: boolean;
}

const QUERIES: readonly HeroQuery[] = [
  { query: "pottery-themed gift for sister under $60", maxPrice: 60, hero: true },
  { query: "hand-thrown ceramic mug", maxPrice: 60, hero: true },
  { query: "handmade ceramic pour-over coffee set", maxPrice: 60, hero: true },
  { query: "ceramic planter handmade", maxPrice: 60, hero: true },
  { query: "handmade pottery vase", maxPrice: 60, hero: true },
  { query: "stoneware serving bowl gift", maxPrice: 60, hero: true },
  { query: "ceramic mug set gift under 40", maxPrice: 40, hero: true },
  { query: "printer paper letter size 500 sheets", hero: false },
  { query: "ballpoint pens pack", hero: false },
  { query: "sticky notes", hero: false },
];

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function intFlag(value: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`--${name} must be an integer between ${min} and ${max} (got ${JSON.stringify(value)}).`);
  }
  return parsed;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1] ?? null;
}

function clip(text: string | null, max: number): string {
  if (text === null) return "–";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Product titles are third-party text: keep them from breaking the markdown table. */
function cell(text: string | null, max: number): string {
  return clip(text, max).replace(/\|/g, "\\|").replace(/`/g, "'");
}

function requestFor(q: HeroQuery, results: number): Channel3SearchRequest {
  return buildChannel3SearchBody({
    query: q.query,
    limit: results,
    ...(q.maxPrice === undefined ? {} : { filters: { price: { max_price: q.maxPrice } } }),
  });
}

interface ProductRow extends ProductSummary {
  bigBrand: string | null;
  handmade: boolean;
  withinBudget: boolean | null;
}

interface QueryRow {
  query: string;
  slug: string;
  hero: boolean;
  maxPrice: number | null;
  status: number | null;
  latencyMs: number;
  count: number;
  error: string | null;
  snapshot: string;
  completeInTop3: number;
  /** Query passes the field check when at least one of its top 3 products has every field. */
  fieldsOk: boolean;
  unbrandedHandmadeOptions: number;
  bigBrandFlags: string[];
  priceFilterViolations: number;
  priceFields: string[];
  currencies: string[];
  top: ProductRow[];
}

function toProductRow(summary: ProductSummary, description: string | null | undefined, maxPrice: number | undefined): ProductRow {
  return {
    ...summary,
    bigBrand: findBigBrand([summary.title, summary.brand]),
    handmade: looksHandmade([summary.title, description]),
    withinBudget: summary.price === null || maxPrice === undefined ? null : summary.price <= maxPrice,
  };
}

function printProduct(index: number, p: ProductRow): void {
  const price = p.price === null ? "no price" : `${p.price.toFixed(2)} ${p.currency ?? "?"}`;
  const flags = [p.bigBrand === null ? "" : `BIG-BRAND:${p.bigBrand}`, p.handmade ? "handmade" : "", p.complete ? "" : "INCOMPLETE"]
    .filter((flag) => flag !== "")
    .join(" ");
  console.log(`   ${index}. ${clip(p.title, 80)}${flags === "" ? "" : `  [${flags}]`}`);
  console.log(
    `      ${price} | merchant ${p.merchant ?? "–"} | brand ${clip(p.brand, 30)} | category ${clip(p.categoryPath ?? p.category, 50)} | image ${p.imageUrl === null ? "no" : "yes"}`,
  );
  console.log(`      ${clip(p.url, 110)}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      limit: { type: "string" },
      results: { type: "string" },
      "delay-ms": { type: "string" },
      query: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const custom = values.query?.trim();
  const pool: readonly HeroQuery[] = custom === undefined || custom === "" ? QUERIES : [{ query: custom, hero: true }];
  const limit = intFlag(values.limit, "limit", pool.length, 1, pool.length);
  const results = intFlag(values.results, "results", 10, 3, CHANNEL3_MAX_LIMIT);
  const delayMs = intFlag(values["delay-ms"], "delay-ms", 400, 0, 10_000);
  const queries = pool.slice(0, limit);

  console.log(describeEnv(["CHANNEL3_API_KEY"]));
  console.log(
    `S7: ${queries.length} quer${queries.length === 1 ? "y" : "ies"} → POST ${CHANNEL3_BASE_URL}${CHANNEL3_SEARCH_PATH} ` +
      `(${results} results each, ${delayMs} ms apart). Cost: ${queries.length} credit(s), plus 1 per 429 retry.`,
  );
  const apiKey = optionalEnv("CHANNEL3_API_KEY");
  if (values["dry-run"]) {
    for (const q of queries) console.log(`  ${slugify(q.query).padEnd(40)} ${JSON.stringify(requestFor(q, results))}`);
    if (apiKey === undefined) throw new ConfigError(`CHANNEL3_API_KEY is not set; add it to ${ENV_FILE} before a real run.`);
    console.log("Dry run: no request sent.");
    return;
  }
  if (apiKey === undefined) {
    throw new ConfigError(
      `CHANNEL3_API_KEY is not set. Create a key at trychannel3.com/developers (redeem the hackathon code from plan §15) and add it to ${ENV_FILE}.`,
    );
  }

  const runAt = new Date().toISOString();
  const rows: QueryRow[] = [];
  let creditsUsed = 0;
  for (const q of queries) {
    const slug = slugify(q.query);
    const body = requestFor(q, results);
    let outcome = await channel3Search(apiKey, body);
    creditsUsed += 1;
    if (outcome.status === 429) {
      // Documented behaviour: 429 with Retry-After: 5, then retry.
      const waitSec = Math.min(outcome.retryAfterSec ?? 5, 10);
      console.log(`  429 on "${q.query}", retrying once after ${waitSec}s`);
      await sleep(waitSec * 1000);
      outcome = await channel3Search(apiKey, body);
      creditsUsed += 1;
    }
    const snapshot = writeOut(`channel3/${slug}.json`, {
      spike: "S7",
      fetchedAt: new Date().toISOString(),
      request: { method: "POST", url: `${CHANNEL3_BASE_URL}${CHANNEL3_SEARCH_PATH}`, body },
      status: outcome.status ?? null,
      latencyMs: Math.round(outcome.latencyMs),
      response: outcome.raw,
    });

    if (outcome.status === 401 || outcome.status === 402) {
      const why = outcome.status === 401 ? "the API key was rejected (401)" : "the account is out of credits (402)";
      throw new ConfigError(`Channel3: ${why}. ${outcome.error ?? ""} Stopping so no more credits are spent.`);
    }

    const products = outcome.parsed?.products ?? [];
    const all = products.map((product) => toProductRow(summarizeProduct(product), product.description, q.maxPrice));
    const top = all.slice(0, 3);
    const row: QueryRow = {
      query: q.query,
      slug,
      hero: q.hero,
      maxPrice: q.maxPrice ?? null,
      status: outcome.status ?? null,
      latencyMs: Math.round(outcome.latencyMs),
      count: products.length,
      error: outcome.error ?? null,
      snapshot,
      completeInTop3: top.filter((p) => p.complete).length,
      fieldsOk: top.some((p) => p.complete),
      unbrandedHandmadeOptions: all.filter((p) => p.complete && p.handmade && p.bigBrand === null && p.withinBudget !== false).length,
      bigBrandFlags: [...new Set(all.map((p) => p.bigBrand).filter((brand): brand is string => brand !== null))],
      priceFilterViolations: all.filter((p) => p.withinBudget === false).length,
      priceFields: [...new Set(all.map((p) => p.priceField).filter((field): field is "price" | "amount" => field !== null))],
      currencies: [...new Set(all.map((p) => p.currency).filter((currency): currency is string => currency !== null))],
      top,
    };
    rows.push(row);

    console.log(
      `\n"${q.query}"${q.maxPrice === undefined ? "" : ` (max $${q.maxPrice})`}: ` +
        (row.error === null ? `${row.count} results` : `ERROR ${row.error}`) +
        ` in ${row.latencyMs} ms; complete in top 3: ${row.completeInTop3}/${top.length}` +
        (q.hero ? `; unbranded handmade options: ${row.unbrandedHandmadeOptions}` : "") +
        (row.bigBrandFlags.length > 0 ? `; big brands: ${row.bigBrandFlags.join(", ")}` : "") +
        (row.priceFilterViolations > 0 ? `; ${row.priceFilterViolations} result(s) above max price` : ""),
    );
    top.forEach((product, index) => printProduct(index + 1, product));
    await sleep(delayMs);
  }

  // Verdict
  const ran = rows.length;
  const fieldsOk = rows.filter((row) => row.fieldsOk).length;
  const needed = Math.ceil(ran * 0.8);
  const heroRows = rows.filter((row) => row.hero);
  const heroWithOption = heroRows.filter((row) => row.unbrandedHandmadeOptions > 0).length;
  const latencies = rows.filter((row) => row.status === 200).map((row) => row.latencyMs);
  const reasons: string[] = [];
  if (fieldsOk < needed) reasons.push(`only ${fieldsOk}/${ran} queries returned a product with price, image, merchant, category and URL (need ${needed})`);
  if (heroRows.length > 0 && heroWithOption === 0) reasons.push("no hero query returned an unbranded handmade option within budget");
  const errors = rows.filter((row) => row.error !== null).length;
  if (errors > 0) reasons.push(`${errors} quer${errors === 1 ? "y" : "ies"} failed`);
  const verdict = reasons.length === 0 ? "PASS" : "FALLBACK";
  const partial = ran < QUERIES.length && custom === undefined;
  const priceFields = [...new Set(rows.flatMap((row) => row.priceFields))];

  const summaryPath = writeOut("channel3/summary.json", {
    spike: "S7",
    runAt,
    settings: { baseUrl: CHANNEL3_BASE_URL, path: CHANNEL3_SEARCH_PATH, results, delayMs, queries: queries.length },
    creditsUsed,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    verdict,
    reasons,
    partialRun: partial,
    priceFieldsSeen: priceFields,
    rows,
  });

  console.log(`\nSnapshots: ${resolve(OUT_DIR, "channel3")}`);
  console.log(`Summary:   ${summaryPath}`);
  console.log(`Verdict: ${verdict}${reasons.length > 0 ? ` — ${reasons.join("; ")}` : ""}${partial ? " (partial run: --limit)" : ""}`);

  const table = [
    "| query | max $ | results | latency ms | complete in top 3 | unbranded handmade | big-brand flags | top pick |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((row) => {
      const pick = row.top.find((p) => p.complete && p.bigBrand === null) ?? row.top[0];
      const pickText =
        pick === undefined ? "–" : `${cell(pick.title, 48)} — ${pick.price === null ? "?" : pick.price.toFixed(2)} ${pick.currency ?? ""} @ ${cell(pick.merchant, 30)}`;
      return (
        `| ${cell(row.query, 60)} | ${row.maxPrice ?? "–"} | ${row.error === null ? row.count : `error ${row.status ?? ""}`} | ${row.latencyMs} | ` +
        `${row.completeInTop3}/${row.top.length} | ${row.hero ? row.unbrandedHandmadeOptions : "n/a"} | ${row.bigBrandFlags.map((b) => cell(b, 30)).join(", ") || "–"} | ${pickText} |`
      );
    }),
  ].join("\n");

  console.log("\n---- paste below into docs/SPIKES.md under \"## S7 — Channel3\" ----\n");
  console.log(
    [
      `**Verdict: ${verdict}**${reasons.length > 0 ? ` — ${reasons.join("; ")}` : ""}${partial ? ` (partial run: ${ran}/${QUERIES.length} queries)` : ""}`,
      "",
      `Run ${runAt} with \`scripts/spike-channel3.ts\`: POST ${CHANNEL3_BASE_URL}${CHANNEL3_SEARCH_PATH}, ${results} results per query, ` +
        `${creditsUsed} credit(s) used. ${fieldsOk}/${ran} queries returned a complete product (price, image, merchant = offer domain, category, URL) in the top 3; ` +
        `${heroWithOption}/${heroRows.length} hero queries had an unbranded handmade option within budget. ` +
        `Latency p50 ${percentile(latencies, 50) ?? "–"} ms, p95 ${percentile(latencies, 95) ?? "–"} ms. Offer price shape seen: ${priceFields.join(", ") || "none"}.`,
      "",
      table,
      "",
      "- Raw responses are saved per query in `scripts/.out/channel3/<slug>.json` (git-ignored) for the cached-snapshot fallback.",
      "- Channel3's caching guide says offer URLs are short-lived and prices change: a snapshot must be refreshed through the free `GET /v1/products/{id}` before it is shown or bought, and labeled as a snapshot when it is not.",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`spike-channel3: ${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (error instanceof ConfigError) {
    console.error(`spike-channel3: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) {
    console.error(`spike-channel3: ${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  console.error(`spike-channel3: unexpected error: ${safeErrorText(String(error), 500)}`);
  process.exitCode = 1;
});
