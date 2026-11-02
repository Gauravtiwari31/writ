"use client";
// Welcome: create a wallet with a passkey (or a labeled device key), sign in, or try the judge path.
import type { LoginOptionsResponse, MetaResponse, RegisterOptionsResponse } from "@writ/core/api";
import { startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, Field, inputClass, Problem } from "../components/ui";
import { api, useLoad } from "../lib/api";
import { ensureDeviceKey } from "../lib/signing";

export default function WelcomePage() {
  const router = useRouter();
  const meta = useLoad<MetaResponse>("/v1/meta");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const attempt = (work: () => Promise<void>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await work();
      router.push("/home");
    } catch (failure) {
      setError(failure instanceof Error ? failure : new Error(String(failure)));
    } finally {
      setBusy(false);
    }
  };

  const displayName = name.trim() === "" ? "Ana" : name.trim();
  const createWithPasskey = attempt(async () => {
    const start = await api<RegisterOptionsResponse>("/v1/auth/register/options", { body: { display_name: displayName } });
    const response = await startRegistration({ optionsJSON: start.options as unknown as PublicKeyCredentialCreationOptionsJSON });
    await api("/v1/auth/register/verify", { body: { challenge_id: start.challenge_id, response } });
  });
  const createWithDeviceKey = attempt(async () => {
    const publicKey = await ensureDeviceKey();
    await api("/v1/auth/device-wallet", { body: { display_name: displayName, public_key: publicKey, label: "This browser" } });
  });
  const signIn = attempt(async () => {
    const start = await api<LoginOptionsResponse>("/v1/auth/login/options", { body: {} });
    const response = await startAuthentication({ optionsJSON: start.options as unknown as PublicKeyCredentialRequestOptionsJSON });
    await api("/v1/auth/login/verify", { body: { challenge_id: start.challenge_id, response } });
  });
  const judge = attempt(async () => {
    await api("/v1/demo/session", { body: {} });
  });

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-4 py-12">
      <div>
        <div aria-hidden className="seal-stamp mb-4 grid size-14 place-items-center rounded-full bg-seal font-serif text-2xl text-white">
          W
        </div>
        <h1 className="text-5xl">Writ</h1>
        <p className="mt-3 font-serif text-xl italic">Signed spending authority for AI agents, enforced on PayPal.</p>
        <p className="mt-3 text-sm text-[var(--muted)]">Agents shop. Writ checks every cart against the limits you signed before PayPal captures a cent, and defends disputes with the proof. Sandbox only: no real money moves.</p>
      </div>

      <Card>
        <h2 className="mb-3 text-xl">Create your wallet</h2>
        <div className="space-y-3">
          <Field label="Your name">
            <input className={inputClass} value={name} placeholder="Ana" maxLength={60} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Button variant="seal" className="w-full" disabled={busy} onClick={createWithPasskey}>
            Create with a passkey
          </Button>
          <Button variant="ghost" className="w-full" disabled={busy} onClick={createWithDeviceKey}>
            No passkey here? Use a device key
          </Button>
          <Button variant="ghost" className="w-full" disabled={busy} onClick={signIn}>
            I already have a wallet: sign in
          </Button>
        </div>
      </Card>

      {meta.data?.judge_mode === true ? (
        <Card>
          <h2 className="text-xl">Judging?</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">Get your own isolated demo wallet with a Writ already signed by a labeled demo key. No sign-up.</p>
          <Button className="mt-3 w-full" disabled={busy} onClick={judge}>
            Try it as a judge
          </Button>
        </Card>
      ) : null}
      {error === null ? null : <Problem error={error} />}
    </main>
  );
}
