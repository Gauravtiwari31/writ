"use client";
// Judge path (plan §18): one click runs scenes 4-8 live. It is a real Atlas run: with no model keys it fails
// visibly and says why, and the rest of the app can still be tried by hand.
import type { DemoStatusResponse, RunView } from "@writ/core/api";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, Loading, Problem, Shell } from "../../components/ui";
import { api, useLoad } from "../../lib/api";

export default function JudgePage() {
  const router = useRouter();
  const status = useLoad<DemoStatusResponse>("/v1/demo/status");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await api<RunView>("/v1/demo/hero-run", { body: {} });
      router.push(`/runs/${started.run_id}`);
    } catch (failure) {
      setError(failure as Error);
      setBusy(false);
    }
  };

  return (
    <Shell title="Run the hero scenario" back="/home">
      {status.loading ? <Loading /> : null}
      {status.error === null ? null : <Problem error={status.error} retry={status.reload} />}
      <Card>
        <p className="text-sm">Atlas, a deliberately naive agent, shops inside your demo Writ. It visits a poisoned deals page (a labeled security test fixture) and tries to buy what the page tells it to. Watch what happens to the money.</p>
        {status.data?.hero_runs_remaining == null ? null : <p className="mt-2 text-xs text-[var(--muted)]">{status.data.hero_runs_remaining} runs left this hour.</p>}
        <Button variant="seal" className="mt-3" disabled={busy} onClick={() => void run()}>
          Run it
        </Button>
      </Card>
      {error === null ? null : <Problem error={error} />}
    </Shell>
  );
}
