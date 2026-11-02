"use client";
// Approval: full attention on one decision. The signature binds this exact purchase and the choice.
import type { ApprovalChallengeResponse, DecideApprovalResponse } from "@writ/core/api";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, Chip, dollars, Hash, Loading, Problem, Shell, stateTone } from "../../../components/ui";
import { api, useLoad } from "../../../lib/api";
import { signChallenge } from "../../../lib/signing";

export default function ApprovalPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const loaded = useLoad<ApprovalChallengeResponse>(`/v1/approvals/${id}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  if (loaded.error !== null) return <Shell title="Approve?" back="/home"><Problem error={loaded.error} retry={loaded.reload} /></Shell>;
  if (loaded.data === null) return <Shell title="Approve?" back="/home"><Loading /></Shell>;
  const { approval, challenges, options } = loaded.data;

  const decide = async (decision: "APPROVE" | "DECLINE") => {
    setBusy(true);
    setError(null);
    try {
      const signature = await signChallenge(challenges[decision], options === null ? null : options[decision]);
      const result = await api<DecideApprovalResponse>(`/v1/approvals/${id}/decide`, { body: { decision, signature } });
      router.push(`/receipts/${result.purchase.purchase_id}`);
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title={`Approve ${dollars(approval.cart_summary.total_minor)}?`} back="/home">
      <Chip tone={stateTone(approval.status)}>{approval.status}</Chip>
      <Card>
        <ul className="space-y-1">
          {approval.cart_summary.items.map((item) => (
            <li key={item.title} className="flex justify-between gap-3 text-sm">
              <span>
                {item.qty} × {item.title}
              </span>
              <span>{dollars(item.unit_minor)}</span>
            </li>
          ))}
        </ul>
        <h2 className="mt-4 text-lg">Why Writ is asking</h2>
        <ul className="mt-1 list-disc pl-5 text-sm">
          {approval.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-[var(--muted)]">
          PayPal is holding this money, not taking it. No answer by {new Date(approval.expires_at).toLocaleString()} cancels the hold. Commitment <Hash value={approval.request.c_pre} />
        </p>
      </Card>
      {approval.status === "PENDING" ? (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="seal" disabled={busy} onClick={() => void decide("APPROVE")}>
            Approve and sign
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => void decide("DECLINE")}>
            Decline
          </Button>
        </div>
      ) : null}
      {error === null ? null : <Problem error={error} />}
    </Shell>
  );
}
