"use client";
// Trust & Safety console (P0-11): AG Studio on this wallet's real data, plus a live attack ticker. Without the
// trial license AG Studio shows its watermark (§22 rule 34). Studio loads only in the browser.
import { CONSOLE_DATASETS, type AttackView, type ConsoleDatasetResponse } from "@writ/core/api";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { Chip, Empty, Loading, Problem, Shell } from "../../components/ui";
import { api, useStream } from "../../lib/api";

const AgStudio = dynamic(() => import("ag-studio-react").then((module) => module.AgStudio), { ssr: false, loading: () => <Loading label="Loading AG Studio…" /> });

export default function ConsolePage() {
  const [sources, setSources] = useState<{ id: string; data: Record<string, unknown>[] }[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [ticker, setTicker] = useState<AttackView[]>([]);

  const load = useCallback(() => {
    Promise.all(CONSOLE_DATASETS.map((name) => api<ConsoleDatasetResponse>(`/api/console/datasets/${name}`)))
      .then((sets) => setSources(sets.map((set) => ({ id: set.name, data: set.rows }))))
      .catch((failure: Error) => setError(failure));
  }, []);
  useEffect(load, [load]);
  useStream((message) => {
    if (message.event.type === "attack.detected") {
      const attack = message.event.data as AttackView;
      setTicker((rows) => [attack, ...rows].slice(0, 20));
    }
  });

  const purchases = sources?.find((source) => source.id === "purchases")?.data ?? [];
  const blocked = purchases.filter((row) => row["state"] === "BLOCKED");
  const stopped = blocked.reduce((sum, row) => sum + (typeof row["amount_minor"] === "number" ? row["amount_minor"] : 0), 0);

  return (
    <Shell title="Trust & Safety">
      {error === null ? null : <Problem error={error} retry={load} />}
      {sources === null && error === null ? <Loading /> : null}
      {sources === null ? null : (
        <>
          <div className="flex flex-wrap gap-2">
            <Chip tone="bad">{blocked.length} blocked</Chip>
            <Chip tone="good">${(stopped / 100).toFixed(2)} stopped from moving</Chip>
            <Chip>{sources.find((source) => source.id === "attacks")?.data.length ?? 0} attacks seen</Chip>
          </div>
          <section aria-label="Attack ticker">
            <h2 className="mb-1 text-lg">Live attacks</h2>
            {ticker.length === 0 ? <Empty title="Nothing new">Attacks appear here as agents run into them.</Empty> : null}
            <ul className="space-y-1">
              {ticker.map((attack) => (
                <li key={attack.attack_id} className="rounded bg-[var(--block-bg)] p-2 font-mono text-xs break-words text-[var(--block)]">
                  {attack.category}: {attack.spans[0]?.text}
                </li>
              ))}
            </ul>
          </section>
          <div className="-mx-4 h-[70dvh] min-h-96 sm:mx-0">
            <AgStudio data={{ sources }} mode="edit" />
          </div>
        </>
      )}
    </Shell>
  );
}
