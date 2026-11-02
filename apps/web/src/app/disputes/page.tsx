"use client";
// Disputes: what PayPal reports, what the analyst recommends, and what waits for you. Money actions take a
// human click. The simulate buttons call PayPal's sandbox-only endpoints and are labeled that way.
import type { DisputeView, ListDisputesResponse } from "@writ/core/api";
import { useState } from "react";
import { Button, Card, Chip, dollars, Empty, Loading, Problem, Shell, stateTone } from "../../components/ui";
import { api, useLoad, useStream } from "../../lib/api";

function Dispute({ dispute, onChange, onError }: { dispute: DisputeView; onChange: () => void; onError: (error: Error) => void }) {
  const act = (path: string, body: unknown) => () => void api(path, { body }).then(onChange).catch(onError);
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-sm">{dispute.paypal_dispute_id}</span>
        <Chip tone={stateTone(dispute.status)}>{dispute.status}</Chip>
      </div>
      <p className="mt-1 text-sm">
        {dollars(dispute.amount_minor)} · {dispute.reason?.replaceAll("_", " ") ?? "no reason given"}
        {dispute.synthetic ? " · synthetic history" : ""}
      </p>
      {dispute.liability === null ? null : (
        <p className="mt-1 text-sm text-[var(--muted)]">
          Analyst: {dispute.liability.replaceAll("_", " ").toLowerCase()}, suggests {dispute.action?.replaceAll("_", " ").toLowerCase()} ({Math.round((dispute.confidence ?? 0) * 100)}% sure)
        </p>
      )}
      {dispute.outcome === null ? null : <p className="mt-1 text-sm font-medium">Outcome: {dispute.outcome.replaceAll("_", " ").toLowerCase()}</p>}
      {dispute.needs_human ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={act(`/v1/disputes/${dispute.dispute_id}/actions`, { action: "PROVIDE_EVIDENCE" })}>Send the evidence</Button>
          <Button variant="ghost" onClick={act(`/v1/disputes/${dispute.dispute_id}/actions`, { action: "ACCEPT_CLAIM" })}>
            Accept and refund
          </Button>
        </div>
      ) : null}
      {dispute.purchase_id !== null && dispute.outcome === null ? (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-[var(--muted)]">Sandbox adjudication</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["escalate", "require-evidence", "adjudicate"] as const).map((step) => (
              <Button key={step} variant="ghost" onClick={act(`/v1/demo/disputes/${dispute.purchase_id}/simulate`, { step, ...(step === "adjudicate" ? { outcome: "SELLER_FAVOR" } : {}) })}>
                {step}
              </Button>
            ))}
          </div>
        </details>
      ) : null}
    </Card>
  );
}

export default function DisputesPage() {
  const disputes = useLoad<ListDisputesResponse>("/v1/disputes");
  const [error, setError] = useState<Error | null>(null);
  useStream((message) => {
    if (message.event.type === "dispute.updated") disputes.reload();
  });
  return (
    <Shell title="Disputes">
      {disputes.error !== null ? <Problem error={disputes.error} retry={disputes.reload} /> : null}
      {error === null ? null : <Problem error={error} />}
      {disputes.loading ? <Loading /> : null}
      {!disputes.loading && disputes.data?.disputes.length === 0 ? <Empty title="No disputes">If a buyer disputes a captured payment, it shows up here with the evidence ready.</Empty> : null}
      {disputes.data?.disputes.map((dispute) => <Dispute key={dispute.dispute_id} dispute={dispute} onChange={disputes.reload} onError={setError} />)}
    </Shell>
  );
}
