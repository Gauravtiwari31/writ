"use client";
// A built-in agent's run, live: each step is a row. Agent and page text is untrusted: rendered as plain text.
import type { RunDetailResponse, RunEvent, RunEventView } from "@writ/core/api";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Button, Chip, dollars, Empty, Loading, Problem, Shell, stateTone } from "../../../components/ui";
import { api, useLoad, useStream } from "../../../lib/api";

function Row({ event }: { event: RunEvent }) {
  switch (event.type) {
    case "run.started":
      return <span>{event.agent_kind === "atlas" ? "Atlas (untrusted demo agent)" : "Scout (hardened demo agent)"} started: {event.goal}</span>;
    case "agent.message":
      return <span className="italic">{event.text}</span>;
    case "tool.called":
      return <span className="text-[var(--muted)]">Calling {event.tool.replaceAll("_", " ")}</span>;
    case "tool.result":
      return <span className={event.ok ? "" : "text-[var(--block)]"}>{event.summary}</span>;
    case "search.results":
      return <span>Found {event.items.length} products for &ldquo;{event.query}&rdquo; ({event.source})</span>;
    case "page.read":
      return (
        <span>
          Read {event.url}
          {event.hidden_chars > 0 ? <strong className="text-[var(--block)]"> · {event.hidden_chars} hidden characters</strong> : null}
        </span>
      );
    case "cart.proposed":
      return (
        <span>
          Proposed a cart of {dollars(event.total_minor)}: <Chip tone={stateTone(event.verdict)}>{event.verdict}</Chip>
          {event.reasons.length > 0 ? <span className="block text-xs text-[var(--block)]">{event.reasons.map((reason) => reason.message).join(" · ")}</span> : null}
        </span>
      );
    case "checkout.result":
      return (
        <span>
          Checkout: <Chip tone={stateTone(event.status)}>{event.status}</Chip> {event.money_moved ? "money moved" : "$0 moved"}{" "}
          <Link className="underline" href={`/receipts/${event.purchase_id}`}>
            details
          </Link>
        </span>
      );
    case "run.finished":
      return <span>Finished: {event.status}{event.failure_code === null ? "" : ` (${event.failure_code.replaceAll("_", " ")})`}</span>;
  }
}

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const loaded = useLoad<RunDetailResponse>(`/v1/runs/${id}`);
  const [live, setLive] = useState<RunEventView[]>([]);
  useStream((message) => {
    if (message.event.type === "run.event" && message.event.data.run_id === id) setLive((rows) => [...rows, message.event.data as RunEventView]);
    if (message.event.type === "run.updated" && message.event.data.run_id === id) loaded.reload();
  });

  if (loaded.error !== null) return <Shell title="Agent run" back="/home"><Problem error={loaded.error} retry={loaded.reload} /></Shell>;
  if (loaded.data === null) return <Shell title="Agent run" back="/home"><Loading /></Shell>;
  const { run, events } = loaded.data;
  const seen = new Set(events.map((event) => event.seq));
  const rows = [...events, ...live.filter((event) => !seen.has(event.seq))].sort((a, b) => a.seq - b.seq);

  return (
    <Shell title="Agent run" back="/home">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={stateTone(run.status)}>{run.status}</Chip>
        <Chip>{run.agent_kind}</Chip>
        {run.status === "RUNNING" ? (
          <Button variant="ghost" onClick={() => void api(`/v1/runs/${id}/stop`, { body: {} }).then(loaded.reload)}>
            Stop
          </Button>
        ) : null}
      </div>
      {run.failure_code === "ai_unavailable" ? <Problem error={new Error(`${run.failure_detail ?? "No model is configured."} Add model keys to .env to send an agent shopping.`)} /> : null}
      {rows.length === 0 ? <Empty title="Nothing yet">Steps appear here as the agent works.</Empty> : null}
      <ol className="space-y-2">
        {rows.map((row) => (
          <li key={row.seq} className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-3 text-sm break-words">
            <Row event={row.event} />
          </li>
        ))}
      </ol>
    </Shell>
  );
}
