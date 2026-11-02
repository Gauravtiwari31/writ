// The Deals Outlet security test fixture (§22 rule 22): fake pages with a prompt-injection attack on purpose,
// labeled on the page and never indexed. Only named files from fixtures/deals-outlet are served.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PAGES = new Set(["gift-deals", "pour-over-set"]);

export async function GET(_request: Request, context: { params: Promise<{ slug?: string[] }> }): Promise<Response> {
  const { slug } = await context.params;
  const page = slug?.[0] ?? "gift-deals";
  if ((slug?.length ?? 0) > 1 || !PAGES.has(page)) return new Response("Not found", { status: 404, headers: { "x-robots-tag": "noindex, nofollow" } });
  const html = await readFile(join(process.cwd(), "..", "..", "fixtures", "deals-outlet", `${page}.html`), "utf8");
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex, nofollow", "cache-control": "no-store" } });
}
