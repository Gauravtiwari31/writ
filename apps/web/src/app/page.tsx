// Placeholder. Owner: web-wallet stream (docs/ARCHITECTURE.md). Replace the whole file.
import { WRIT_SPEC } from "@writ/core";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Writ" };

export default function WelcomePage() {
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="font-serif text-3xl">Writ</h1>
      <p className="mt-2 text-sm opacity-80">Welcome: create a wallet, sign in with a passkey, or try it as a judge.</p>
      <p className="mt-6 font-mono text-xs opacity-60">Coming soon · owner: web-wallet stream · {WRIT_SPEC}</p>
    </main>
  );
}
