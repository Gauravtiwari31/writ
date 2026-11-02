"use client";
// One Writ: the permission card as signed, its serial number, starting a built-in agent, revoking.
import type { RunView, WritView } from "@writ/core/api";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, Chip, dollars, Hash, Loading, Problem, Shell, stateTone } from "../../../components/ui";
import { api, useLoad } from "../../../lib/api";

export default function WritPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const writ = useLoad<WritView>(`/v1/writs/${id}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  };

  if (writ.error !== null) return <Shell title="Writ" back="/home"><Problem error={writ.error} retry={writ.reload} /></Shell>;
  if (writ.data === null) return <Shell title="Writ" back="/home"><Loading /></Shell>;
  const view = writ.data;

  const runAgent = () =>
    act(async () => {
      const agents = await api<{ agents: { agent_id: string; builtin_kind: "atlas" | "scout" | null }[] }>("/v1/agents");
      const bound = agents.agents.find((agent) => agent.agent_id === view.agent_id);
      if (bound?.builtin_kind === null || bound === undefined) throw new Error("This Writ is signed for your own agent: use its key to shop with the agent API.");
      const run = await api<RunView>("/v1/runs", { body: { agent: bound.builtin_kind, writ_id: view.writ_id } });
      router.push(`/runs/${run.run_id}`);
    });
  const revoke = () =>
    act(async () => {
      await api(`/v1/writs/${view.writ_id}/revoke`, { body: {} });
      writ.reload();
    });

  return (
    <Shell title={view.body.purpose} back="/home">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={stateTone(view.status)}>{view.status}</Chip>
        {view.signature_kind === null ? null : <Chip>{view.signature_kind === "webauthn" ? "signed with a passkey" : "signed with a device key"}</Chip>}
      </div>
      <Card>
        <h2 className="mb-2 text-xl">What you allowed</h2>
        <ul className="space-y-1 text-sm">
          {view.summary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-[var(--muted)]">
          Serial number <Hash value={view.hash} length={64} />
        </p>
      </Card>
      {view.budget === null ? null : (
        <Card>
          <h2 className="mb-1 text-xl">Budget</h2>
          <p className="text-sm">
            {dollars(view.budget.spent_minor)} spent · {dollars(view.budget.reserved_minor)} held · {dollars(view.budget.remaining_minor)} left
          </p>
          <p className="text-xs text-[var(--muted)]">
            {view.budget.orders_count} of {view.budget.max_orders} orders used
          </p>
        </Card>
      )}
      {view.status === "ACTIVE" ? (
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={runAgent}>
            Send the agent shopping
          </Button>
          <Button variant="danger" disabled={busy} onClick={revoke}>
            Revoke this Writ
          </Button>
        </div>
      ) : null}
      {error === null ? null : <Problem error={error} />}
      <details className="text-xs">
        <summary className="cursor-pointer text-[var(--muted)]">Show the exact signed JSON</summary>
        <pre className="mt-2 overflow-x-auto rounded border border-[var(--line)] p-3 font-mono">{JSON.stringify(view.body, null, 2)}</pre>
      </details>
    </Shell>
  );
}
