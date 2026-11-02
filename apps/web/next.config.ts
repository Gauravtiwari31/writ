// Writ Wallet + console (Next.js App Router). The browser only ever talks to this origin: /gw/* is
// rewritten to the gateway, so the session cookie is first-party on the Wallet host and WebAuthn
// runs here (RP ID = this host, plan decision 2). Agents call the gateway directly.
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md).
import type { NextConfig } from "next";

/** Gateway origin for the /gw rewrite. Read at build time (rewrites are compiled into the build). */
const gatewayOrigin = new URL(process.env.GATEWAY_BASE_URL ?? "http://localhost:10000").origin;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `next dev` would otherwise write its own apps/web/AGENTS.md on every run; the repo's agent
  // rules live in the root AGENTS.md (plan §22) and must stay the only ones.
  agentRules: false,
  // Workspace packages ship TypeScript sources.
  transpilePackages: ["@writ/core", "@writ/ledger"],
  async rewrites() {
    return [{ source: "/gw/:path*", destination: `${gatewayOrigin}/:path*` }];
  },
  async headers() {
    return [
      // Security test fixtures (§22 rule 22): never indexed.
      { source: "/fixtures/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
    ];
  },
};

export default nextConfig;
