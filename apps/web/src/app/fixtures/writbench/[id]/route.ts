// WritBench security test fixtures (§22 rule 22): fake attack pages, labeled on the page and never indexed.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const headers = { "x-robots-tag": "noindex, nofollow" };
  if (!/^wb-[a-z]{3}-\d{3}$/.test(id)) return new Response("Not found", { status: 404, headers });
  try {
    const html = await readFile(join(process.cwd(), "..", "..", "fixtures", "writbench", `${id}.html`), "utf8");
    return new Response(html, { headers: { ...headers, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  } catch {
    return new Response("Not found", { status: 404, headers });
  }
}
