// Placeholder. Owner: web-flows stream. Serves the Deals Outlet security test fixture pages from
// <repo>/fixtures/deals-outlet (written by the agents stream) with noindex and the visible label
// "security test fixture" (§22 rule 22). Until then it answers a labeled placeholder page.
const PLACEHOLDER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>Deals Outlet (security test fixture)</title></head>
<body><p><strong>Security test fixture.</strong> Deals Outlet pages are not served yet (owner: web-flows stream).</p></body></html>`;

export function GET(): Response {
  return new Response(PLACEHOLDER, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex, nofollow", "cache-control": "no-store" },
  });
}
