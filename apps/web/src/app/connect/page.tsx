"use client";
// Connect PayPal once (P0-2): the buyer approves a Vault setup token at PayPal; agents then pay within a Writ
// without a click each time. This is the approve-URL flow; the JS SDK v6 button comes after spike S1 shows which
// sandbox flow works. Without PayPal keys the screen says so and nothing is simulated.
import type { CreateSetupTokenResponse, PayPalConfigResponse, VaultStatusView } from "@writ/core/api";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Button, Card, Chip, Loading, Problem, Shell, stateTone } from "../../components/ui";
import { api, useLoad } from "../../lib/api";

const PENDING_KEY = "writ-setup-token";

function Connect() {
  const config = useLoad<PayPalConfigResponse>("/v1/paypal/config");
  const vault = useLoad<VaultStatusView>("/v1/paypal/vault");
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const finished = useRef(false);

  useEffect(() => {
    const result = params.get("result");
    if (result !== "approved" || finished.current) return;
    finished.current = true;
    const pending = sessionStorage.getItem(PENDING_KEY);
    if (pending === null) return;
    sessionStorage.removeItem(PENDING_KEY);
    api("/v1/paypal/vault/payment-token", { body: { setup_token_id: pending } })
      .then(vault.reload)
      .catch((failure: Error) => setError(failure));
  }, [params, vault.reload]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await api<CreateSetupTokenResponse>("/v1/paypal/vault/setup-token", { body: { flow: "redirect" } });
      if (token.approve_url === null) throw new Error("PayPal did not return an approval link.");
      sessionStorage.setItem(PENDING_KEY, token.setup_token_id);
      window.location.assign(token.approve_url);
    } catch (failure) {
      setError(failure as Error);
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setError(null);
    try {
      await api("/v1/paypal/vault/disconnect", { body: {} });
      vault.reload();
    } catch (failure) {
      setError(failure as Error);
    }
  };

  const failure = config.error ?? vault.error ?? error;
  return (
    <Shell title="Connect PayPal">
      {config.loading || vault.loading ? <Loading /> : null}
      {failure === null ? null : <Problem error={failure} />}
      {config.data?.configured === false ? (
        <Card>
          <h2 className="text-xl">PayPal is not set up yet</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">Add the sandbox keys (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET) to .env and restart. Until then, a cart that passes the rules stops at PayPal with a clear reason.</p>
        </Card>
      ) : null}
      {config.data?.configured === true && vault.data !== null ? (
        <Card>
          <div className="flex items-center gap-2">
            <h2 className="text-xl">Your PayPal wallet</h2>
            <Chip tone={stateTone(vault.data.connected ? "ACTIVE" : vault.data.status)}>{vault.data.connected ? "connected" : vault.data.status.toLowerCase()}</Chip>
            {vault.data.demo ? <Chip tone="warn">demo token</Chip> : null}
          </div>
          {vault.data.payer_hint === null ? null : <p className="mt-1 text-sm">{vault.data.payer_hint}</p>}
          <p className="mt-2 text-sm text-[var(--muted)]">You approve once at PayPal. Each payment still has to pass the Writ you signed.</p>
          {vault.data.connected ? (
            <Button variant="danger" className="mt-3" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          ) : (
            <Button variant="seal" className="mt-3" disabled={busy} onClick={() => void start()}>
              Connect with PayPal (sandbox)
            </Button>
          )}
        </Card>
      ) : null}
    </Shell>
  );
}

export default function ConnectPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Connect />
    </Suspense>
  );
}
