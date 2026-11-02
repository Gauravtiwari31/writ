"use client";
// One purchase: what was blocked and why (hidden text in red), the two keys, and the proof. The hash chain is
// re-verified here in the browser, so the screen does not ask you to trust the server's word.
import type { EvidenceLinkView, PurchaseDetailResponse, ReceiptView } from "@writ/core/api";
import { verifyChain } from "@writ/ledger";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Button, Card, Chip, dollars, Hash, Loading, Problem, Shell, stateTone } from "../../../components/ui";
import { api, useLoad, useStream } from "../../../lib/api";

const REASON_TEXT: Record<string, string> = {
  policy_blocked: "The rules stopped this. No PayPal authorization was created.",
  budget_exhausted: "No budget or order slot was left. No PayPal authorization was created.",
  paypal_unconfigured: "PayPal is not set up on this gateway, so nothing was authorized. The hold on your budget was released.",
  paypal_not_connected: "No PayPal wallet is connected, so nothing was authorized. The hold on your budget was released.",
  human_declined: "You declined this. The hold was cancelled.",
  approval_expired: "Nobody answered within 24 hours, so the hold was cancelled.",
  verifier_blocked: "The independent check refused this. The hold was cancelled.",
  kill_switch: "The kill switch cancelled this hold.",
  writ_revoked: "The Writ was revoked, so the hold was cancelled.",
};

export default function ReceiptPage() {
  const { purchaseId } = useParams<{ purchaseId: string }>();
  const detail = useLoad<PurchaseDetailResponse>(`/v1/purchases/${purchaseId}`);
  const receipt = useLoad<ReceiptView>(`/v1/receipts/${purchaseId}`);
  const [link, setLink] = useState<EvidenceLinkView | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useStream((message) => {
    if (message.event.type === "purchase.updated" && message.event.data.purchase_id === purchaseId) {
      detail.reload();
      receipt.reload();
    }
  });

  const chain = useMemo(() => (receipt.data === null ? null : verifyChain(receipt.data.events)), [receipt.data]);

  if (detail.error !== null) return <Shell title="Purchase" back="/home"><Problem error={detail.error} retry={detail.reload} /></Shell>;
  if (detail.data === null) return <Shell title="Purchase" back="/home"><Loading /></Shell>;
  const { purchase, cart, attacks, decisions, approval_id: approvalId } = detail.data;
  const blocked = purchase.state === "BLOCKED";
  const policy = decisions.find((decision) => decision.stage === "policy");
  const reasons = (policy?.reasons ?? []) as { message?: string; code?: string }[];

  const makeLink = async () => {
    setError(null);
    try {
      setLink(await api<EvidenceLinkView>("/v1/evidence-links", { body: { purchase_id: purchaseId } }));
    } catch (failure) {
      setError(failure as Error);
    }
  };

  return (
    <Shell title={dollars(purchase.amount_minor)} back="/home">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={stateTone(purchase.state)}>{purchase.state}</Chip>
        <Chip tone="warn">sandbox</Chip>
        {cart.items.some((item) => item.product_ref.startsWith("fx_")) ? <Chip>security test fixture · simulated fulfillment</Chip> : null}
      </div>
      {purchase.state_reason === null || REASON_TEXT[purchase.state_reason] === undefined ? null : <p className="text-sm">{REASON_TEXT[purchase.state_reason]}</p>}
      {blocked ? <p className="font-serif text-2xl text-[var(--block)]">$0 moved.</p> : null}
      {purchase.state === "AWAITING_HUMAN" && approvalId !== null ? (
        <Link href={`/approvals/${approvalId}`} className="block rounded-md bg-seal p-3 text-center text-sm font-medium text-white">
          This needs your answer
        </Link>
      ) : null}

      <Card>
        <h2 className="mb-2 text-xl">Cart</h2>
        <ul className="space-y-1 text-sm">
          {cart.items.map((item) => (
            <li key={item.product_ref} className={`flex justify-between gap-3 ${blocked ? "line-through decoration-[var(--block)]" : ""}`}>
              <span>
                {item.qty} × {item.title}
              </span>
              <span>{dollars(item.unit_minor)}</span>
            </li>
          ))}
        </ul>
      </Card>

      {blocked && reasons.length > 0 ? (
        <Card className="border-[var(--block)]">
          <h2 className="mb-2 text-xl">Why it was blocked</h2>
          <ul className="space-y-1 text-sm text-[var(--block)]">
            {reasons.map((reason) => (
              <li key={`${reason.code}-${reason.message}`}>{reason.message ?? reason.code}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      {attacks.length > 0 ? (
        <Card className="border-[var(--block)]">
          <h2 className="text-xl">Hidden text found</h2>
          {attacks.map((attack) => (
            <div key={attack.attack_id} className="mt-2">
              <p className="text-xs break-all text-[var(--muted)]">
                {attack.source_url} · {attack.category} · found by {attack.detector}
              </p>
              <ul className="mt-1 space-y-1">
                {attack.spans.map((span) => (
                  <li key={`${span.channel}-${span.start}`} className="rounded bg-[var(--block-bg)] p-2 font-mono text-xs text-[var(--block)]">
                    {span.channel}: {span.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-2 text-xl">The checks</h2>
        <ul className="divide-y divide-[var(--line)]">
          {decisions.map((decision) => (
            <li key={decision.decision_id} className="flex items-center justify-between py-1.5 text-sm">
              <span className="capitalize">{decision.stage}</span>
              <Chip tone={stateTone(decision.verdict)}>{decision.verdict}</Chip>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <h2 className="mb-2 text-xl">Proof</h2>
        {receipt.error !== null ? <Problem error={receipt.error} retry={receipt.reload} /> : null}
        {chain === null ? <Loading /> : <p className="text-sm">{chain.ok ? "Hash chain re-verified in this browser." : `The hash chain does NOT verify: ${chain.reason}`}</p>}
        {purchase.paypal.order_id === null ? (
          <p className="mt-1 text-xs text-[var(--muted)]">PayPal was never called, so there are no PayPal IDs.</p>
        ) : (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt>Order</dt>
            <dd><Hash value={purchase.paypal.order_id} length={40} /></dd>
            <dt>Authorization</dt>
            <dd><Hash value={purchase.paypal.authorization_id} length={40} /></dd>
            <dt>Capture</dt>
            <dd><Hash value={purchase.paypal.capture_id} length={40} /></dd>
            <dt>custom_id</dt>
            <dd><Hash value={receipt.data?.commitments.custom_id} length={70} /></dd>
            <dt>invoice_id</dt>
            <dd><Hash value={receipt.data?.commitments.invoice_id} length={70} /></dd>
          </dl>
        )}
        {(receipt.data?.checks.length ?? 0) > 0 ? (
          <ul className="mt-3 grid grid-cols-2 gap-1 text-xs">
            {receipt.data?.checks.map((check) => (
              <li key={check.name} className="flex items-center gap-1">
                <Chip tone={check.status === "PASS" ? "good" : check.status === "FAIL" ? "bad" : "plain"}>{check.status}</Chip> {check.name}
              </li>
            ))}
          </ul>
        ) : null}
        {receipt.data?.pack_available === true ? (
          <div className="mt-3">
            {link === null ? (
              <Button variant="ghost" onClick={() => void makeLink()}>
                Make an evidence link
              </Button>
            ) : (
              <p className="flex gap-4 text-sm">
                <a className="underline" href={`/gw${link.pdf_path}`}>
                  Evidence PDF
                </a>
                <a className="underline" href={`/gw${link.json_path}`}>
                  Evidence JSON
                </a>
              </p>
            )}
          </div>
        ) : null}
        {error === null ? null : <div className="mt-2"><Problem error={error} /></div>}
      </Card>
    </Shell>
  );
}
