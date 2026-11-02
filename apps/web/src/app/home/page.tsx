// Placeholder. Owner: web-wallet stream (docs/ARCHITECTURE.md). Replace the whole file.
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Home" };

export default function HomePage() {
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="font-serif text-3xl">Home</h1>
      <p className="mt-2 text-sm opacity-80">Active Writs with burn-down, activity, alerts and Revoke all.</p>
      <p className="mt-6 font-mono text-xs opacity-60">Coming soon · owner: web-wallet stream</p>
    </main>
  );
}
