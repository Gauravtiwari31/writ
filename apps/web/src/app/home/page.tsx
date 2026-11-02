"use client";
// Home: active Writs with burn-down, things waiting on you, activity, and the kill switch.
import type { ListApprovalsResponse, ListPurchasesResponse, ListWritsResponse, MetaResponse, MeResponse } from "@writ/core/api";
import Link from "next/link";
import { useState } from "react";
import { Button, Card, Chip, dollars, Empty, Hash, Loading, Problem, Shell, stateTone } from "../../components/ui";
import { api, useLoad, useStream } from "../../lib/api";

export default function HomePage() {
  const me = useLoad<MeResponse>("/v1/me");
  const meta = useLoad<MetaResponse>("/v1/meta");
  const writs = useLoad<ListWritsResponse>("/v1/writs");
  const purchases = useLoad<ListPurchasesResponse>("/v1/purchases");
  const approvals = useLoad<ListApprovalsResponse>("/v1/approvals?status=PENDING");
  const [killing, setKilling] = useState(false);
  const [killError, setKillError] = useState<Error | null>(null);

  useStream(() => {
    writs.reload();
    purchases.reload();
    approvals.reload();
  });

  const killSwitch = async () => {
    if (!window.confirm("Revoke every Writ and cancel every hold in progress?")) return;
    setKilling(true);
    setKillError(null);
    try {
      await api("/v1/kill-switch", { body: {} });
      writs.reload();
      purchases.reload();
    } catch (failure) {
      setKillError(failure as Error);
    } finally {
      setKilling(false);
    }
  };

  if (me.error !== null) return <Shell title="Home"><Problem error={me.error} retry={me.reload} /></Shell>;
  const active = writs.data?.writs.filter((writ) => writ.status === "ACTIVE") ?? [];
  const missing = [
    meta.data?.paypal.configured === false ? "PayPal keys" : null,
    meta.data?.ai.verifier === false ? "the Verifier model" : null,
    meta.data?.ai.agent === false ? "an agent model" : null,
    meta.data?.channel3 === false ? "Channel3" : null,
  ].filter((item): item is string => item !== null);

  return (
    <Shell title={me.data === null ? "Home" : `Hello, ${me.data.session.user.display_name}`}>
      {me.data?.session.user.demo === true ? (
        <div className="flex flex-wrap items-center gap-3">
          <Chip tone="warn">demo account: seeded, labeled, sandbox only</Chip>
          <Link href="/judge" className="text-sm underline">
            Run the hero scenario
          </Link>
        </div>
      ) : null}
      {missing.length > 0 ? (
        <p className="rounded-md border border-[var(--line)] p-3 text-xs text-[var(--muted)]">
          Running without {missing.join(", ")}. Those steps fail closed and say so; nothing is simulated.
        </p>
      ) : null}

      {(approvals.data?.approvals.length ?? 0) > 0 ? (
        <Card className="border-seal">
          <h2 className="text-xl">Waiting for you</h2>
          <ul className="mt-2 space-y-2">
            {approvals.data?.approvals.map((approval) => (
              <li key={approval.approval_id}>
                <Link className="underline" href={`/approvals/${approval.approval_id}`}>
                  Approve or decline {dollars(approval.cart_summary.total_minor)}: {approval.cart_summary.items[0]?.title}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="flex items-center justify-between">
        <h2 className="text-xl">Your Writs</h2>
        <Link href="/writs/new" className="text-sm underline">
          New Writ
        </Link>
      </div>
      {writs.error !== null ? <Problem error={writs.error} retry={writs.reload} /> : null}
      {writs.loading ? <Loading /> : null}
      {!writs.loading && writs.data?.writs.length === 0 ? (
        <Empty title="No Writs yet">
          <Link className="underline" href="/writs/new">
            Write your first one
          </Link>
          : what an agent may buy, how much, and when to ask you.
        </Empty>
      ) : null}
      {writs.data?.writs.map((writ) => {
        const limit = writ.budget === null ? 0n : BigInt(writ.budget.limit_minor);
        const used = writ.budget === null ? 0n : BigInt(writ.budget.spent_minor) + BigInt(writ.budget.reserved_minor);
        const percent = limit === 0n ? 0 : Number((used * 100n) / limit);
        return (
          <Card key={writ.writ_id}>
            <div className="flex items-start justify-between gap-2">
              <Link href={`/writs/${writ.writ_id}`} className="font-serif text-lg underline-offset-2 hover:underline">
                {writ.body.purpose}
              </Link>
              <Chip tone={stateTone(writ.status)}>{writ.status}</Chip>
            </div>
            {writ.budget === null ? null : (
              <div className="mt-3">
                <div className="h-2 overflow-hidden rounded bg-[var(--line)]" role="img" aria-label={`${percent}% of the budget used`}>
                  <div className="h-full bg-seal" style={{ width: `${percent}%` }} />
                </div>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  {dollars(writ.budget.spent_minor)} spent · {dollars(writ.budget.reserved_minor)} held · {dollars(writ.budget.remaining_minor)} left of {dollars(writ.budget.limit_minor)}
                </p>
              </div>
            )}
            <p className="mt-2 text-xs text-[var(--muted)]">
              Serial <Hash value={writ.hash} />
            </p>
          </Card>
        );
      })}

      <h2 className="text-xl">Activity</h2>
      {purchases.error !== null ? <Problem error={purchases.error} retry={purchases.reload} /> : null}
      {!purchases.loading && purchases.data?.purchases.length === 0 ? <Empty title="No purchases yet">When an agent checks out, each attempt shows up here.</Empty> : null}
      <ul className="space-y-2">
        {purchases.data?.purchases.map((purchase) => (
          <li key={purchase.purchase_id}>
            <Link href={`/receipts/${purchase.purchase_id}`} className="flex items-center justify-between gap-2 rounded-md border border-[var(--line)] bg-[var(--surface)] p-3 text-sm">
              <span>
                {dollars(purchase.amount_minor)} <span className="text-xs text-[var(--muted)]">{purchase.state_reason?.replaceAll("_", " ") ?? ""}</span>
              </span>
              <Chip tone={stateTone(purchase.state)}>{purchase.state}</Chip>
            </Link>
          </li>
        ))}
      </ul>

      {active.length > 0 ? (
        <Card className="border-[var(--block)]">
          <h2 className="text-xl">Kill switch</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">Revoke every Writ at once and cancel any hold still in progress.</p>
          <Button variant="danger" className="mt-3" disabled={killing} onClick={killSwitch}>
            Revoke all
          </Button>
          {killError === null ? null : <div className="mt-2"><Problem error={killError} /></div>}
        </Card>
      ) : null}
    </Shell>
  );
}
