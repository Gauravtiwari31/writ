"use client";
// Agents & keys: the built-in demo agents and your own. A key is shown once and stored only as a hash.
import type { CreateAgentResponse, ListAgentsResponse } from "@writ/core/api";
import { useState } from "react";
import { Button, Card, Chip, Field, inputClass, Loading, Problem, Shell } from "../../components/ui";
import { api, useLoad } from "../../lib/api";

export default function AgentsPage() {
  const agents = useLoad<ListAgentsResponse>("/v1/agents");
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreateAgentResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const create = async () => {
    setError(null);
    try {
      setCreated(await api<CreateAgentResponse>("/v1/agents", { body: { name: name.trim(), kind: "sdk" } }));
      setName("");
      agents.reload();
    } catch (failure) {
      setError(failure as Error);
    }
  };
  const revoke = async (id: string) => {
    setError(null);
    try {
      await api(`/v1/agents/${id}/revoke`, { body: {} });
      agents.reload();
    } catch (failure) {
      setError(failure as Error);
    }
  };

  return (
    <Shell title="Agents & keys">
      {agents.error !== null ? <Problem error={agents.error} retry={agents.reload} /> : null}
      {agents.loading ? <Loading /> : null}
      <ul className="space-y-2">
        {agents.data?.agents.map((agent) => (
          <li key={agent.agent_id}>
            <Card className="flex items-center justify-between gap-2">
              <div>
                <p className="font-medium">{agent.name}</p>
                <p className="font-mono text-xs text-[var(--muted)]">key ends {agent.key_hint}</p>
              </div>
              {agent.revoked_at !== null ? (
                <Chip tone="bad">revoked</Chip>
              ) : agent.kind === "builtin" ? (
                <Chip>built in</Chip>
              ) : (
                <Button variant="danger" onClick={() => void revoke(agent.agent_id)}>
                  Revoke
                </Button>
              )}
            </Card>
          </li>
        ))}
      </ul>
      <Card>
        <h2 className="mb-2 text-xl">Add your own agent</h2>
        <Field label="Name">
          <input className={inputClass} value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Button className="mt-3" disabled={name.trim() === ""} onClick={() => void create()}>
          Create a key
        </Button>
        {created === null ? null : (
          <div className="mt-3 rounded-md border border-seal p-3">
            <p className="text-sm font-medium">Copy this key now. It is shown once.</p>
            <code className="mt-1 block font-mono text-xs break-all">{created.api_key}</code>
          </div>
        )}
      </Card>
      {error === null ? null : <Problem error={error} />}
    </Shell>
  );
}
