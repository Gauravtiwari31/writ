"use client";
// New Writ: a sentence → draft (when a compiler model is configured) → the permission card, editable → sign.
// Without a model the card is simply filled in by hand. Nothing is ever signed for the person.
import { CATEGORY_PARENT_LABELS, type WritDraft } from "@writ/core";
import type { CompileResponse, CreateWritResponse, ListAgentsResponse, MeResponse, MetaResponse } from "@writ/core/api";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button, Card, Field, inputClass, Loading, Problem, Shell, toMinor } from "../../../components/ui";
import { api, ApiError, useLoad } from "../../../lib/api";
import { signChallenge } from "../../../lib/signing";

const DENY_KINDS = ["gift_card", "protection_plan", "subscription", "digital_goods", "money_transfer", "crypto"] as const;

function fromMinor(minor: string | null | undefined): string {
  return minor === null || minor === undefined ? "" : (Number(minor) / 100).toFixed(2);
}

export default function NewWritPage() {
  const router = useRouter();
  const me = useLoad<MeResponse>("/v1/me");
  const agents = useLoad<ListAgentsResponse>("/v1/agents");
  const meta = useLoad<MetaResponse>("/v1/meta");
  const [text, setText] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);
  const [purpose, setPurpose] = useState("");
  const [budget, setBudget] = useState("60");
  const [askAbove, setAskAbove] = useState("40");
  const [categories, setCategories] = useState<string[]>(["home_kitchen", "arts_crafts"]);
  const [deliverBy, setDeliverBy] = useState("");
  const [expires, setExpires] = useState("7");
  const [agentId, setAgentId] = useState("");
  const [addressId, setAddressId] = useState("");
  const [addr, setAddr] = useState({ label: "Home", line1: "", city: "", region: "", postal: "", country: "US" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const addresses = useMemo(() => me.data?.addresses ?? [], [me.data]);
  const agentList = useMemo(() => (agents.data?.agents ?? []).filter((agent) => agent.revoked_at === null), [agents.data]);
  useEffect(() => {
    if (agentId === "" && agentList[0] !== undefined) setAgentId((agentList.find((agent) => agent.builtin_kind === "atlas") ?? agentList[0]).agent_id);
  }, [agentId, agentList]);
  useEffect(() => {
    if (addressId === "" && addresses[0] !== undefined) setAddressId(addresses[0].address_id);
  }, [addressId, addresses]);

  const compile = async () => {
    setCompiling(true);
    setError(null);
    setNote(null);
    if (meta.data?.ai.compiler === false) {
      setPurpose(text.slice(0, 140));
      setNote("No compiler model is set up, so fill in the card by hand.");
      setCompiling(false);
      return;
    }
    try {
      const { draft } = await api<CompileResponse>("/v1/writs/compile", { body: { text } });
      const c = draft.constraints;
      setPurpose(draft.purpose);
      setBudget(fromMinor(c.total_minor));
      setAskAbove(fromMinor(c.require_human_above_minor));
      if (c.categories != null && c.categories.length > 0) setCategories(c.categories.map((category) => category.split(".")[0] ?? category));
      setDeliverBy(c.deliver_by ?? "");
      setQuestions(draft.clarifying_questions);
      setNote("Check every line before you sign.");
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "ai_unavailable") {
        setPurpose(text.slice(0, 140));
        setNote("No compiler model is set up, so fill in the card by hand.");
      } else {
        setError(failure as Error);
      }
    } finally {
      setCompiling(false);
    }
  };

  const toggle = (category: string) => setCategories((current) => (current.includes(category) ? current.filter((item) => item !== category) : [...current, category]));

  const sign = async () => {
    setBusy(true);
    setError(null);
    try {
      const total = toMinor(budget);
      const ask = toMinor(askAbove);
      if (total === null || total === "0") throw new Error("Enter a budget, like 60.");
      if (ask === null) throw new Error("Enter the amount above which you want to be asked, like 40.");
      if (purpose.trim() === "") throw new Error("Say what this Writ is for.");
      if (categories.length === 0) throw new Error("Pick at least one category.");
      let shipTo = addressId;
      if (shipTo === "") {
        const created = await api<{ address_id: string }>("/v1/address-book", { body: { ...addr, region: addr.region === "" ? null : addr.region } });
        shipTo = created.address_id;
      }
      const draft: WritDraft = {
        purpose: purpose.trim().slice(0, 140),
        constraints: {
          total_minor: total,
          require_human_above_minor: ask,
          categories: categories as NonNullable<WritDraft["constraints"]["categories"]>,
          deny_kinds: [...DENY_KINDS],
          ship_to_locked: true,
          deliver_by: deliverBy === "" ? null : deliverBy,
          expires_in_days: Number(expires),
        },
        clarifying_questions: [],
        assumptions: [],
      };
      const created = await api<CreateWritResponse>("/v1/writs", { body: { draft, agent_id: agentId, ship_to_ref: shipTo } });
      const signature = await signChallenge(created.challenge, created.sign_options);
      await api(`/v1/writs/${created.writ.writ_id}/sign`, { body: { signature } });
      router.push(`/writs/${created.writ.writ_id}`);
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  };

  if (me.error !== null) return <Shell title="New Writ"><Problem error={me.error} retry={me.reload} /></Shell>;
  if (me.loading || agents.loading) return <Shell title="New Writ"><Loading /></Shell>;

  return (
    <Shell title="New Writ">
      <Card>
        <Field label="Say it in a sentence" hint="For example: a pottery-themed gift for my sister, under $60, by Nov 20, ask me above $40.">
          <textarea className={`${inputClass} min-h-20`} value={text} maxLength={2000} onChange={(event) => setText(event.target.value)} />
        </Field>
        <Button variant="ghost" className="mt-3" disabled={compiling || text.trim() === ""} onClick={compile}>
          {compiling ? "Drafting…" : "Draft the permission card"}
        </Button>
        {note === null ? null : <p className="mt-2 text-sm text-[var(--muted)]">{note}</p>}
        {questions.map((question) => (
          <p key={question} className="mt-2 text-sm">
            Question: {question}
          </p>
        ))}
      </Card>

      <Card>
        <h2 className="mb-3 text-xl">Permission card</h2>
        <div className="space-y-3">
          <Field label="What it is for">
            <input className={inputClass} value={purpose} maxLength={140} onChange={(event) => setPurpose(event.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Can spend up to ($)">
              <input className={inputClass} inputMode="decimal" value={budget} onChange={(event) => setBudget(event.target.value)} />
            </Field>
            <Field label="Must ask you above ($)">
              <input className={inputClass} inputMode="decimal" value={askAbove} onChange={(event) => setAskAbove(event.target.value)} />
            </Field>
          </div>
          <fieldset>
            <legend className="text-sm font-medium">Only these categories</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {Object.entries(CATEGORY_PARENT_LABELS).map(([key, label]) => (
                <label key={key} className={`flex min-h-9 cursor-pointer items-center gap-1 rounded border px-2 text-xs ${categories.includes(key) ? "border-seal" : "border-[var(--line)]"}`}>
                  <input type="checkbox" checked={categories.includes(key)} onChange={() => toggle(key)} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Must arrive by" hint="Optional">
              <input type="date" className={inputClass} value={deliverBy} onChange={(event) => setDeliverBy(event.target.value)} />
            </Field>
            <Field label="Expires in (days)">
              <input className={inputClass} inputMode="numeric" value={expires} onChange={(event) => setExpires(event.target.value)} />
            </Field>
          </div>
          <Field label="Agent allowed to use it">
            <select className={inputClass} value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              {agentList.map((agent) => (
                <option key={agent.agent_id} value={agent.agent_id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </Field>
          {addresses.length > 0 ? (
            <Field label="Ships only to" hint="Locked: agents only ever see this label.">
              <select className={inputClass} value={addressId} onChange={(event) => setAddressId(event.target.value)}>
                {addresses.map((address) => (
                  <option key={address.address_id} value={address.address_id}>
                    {address.label}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Ships only to</legend>
              <p className="text-xs text-[var(--muted)]">Locked: agents only ever see the label, never the street.</p>
              <input aria-label="Label" className={inputClass} placeholder="Label, like Home" value={addr.label} onChange={(event) => setAddr({ ...addr, label: event.target.value })} />
              <input aria-label="Street" className={inputClass} placeholder="Street" value={addr.line1} onChange={(event) => setAddr({ ...addr, line1: event.target.value })} />
              <div className="grid grid-cols-3 gap-2">
                <input aria-label="City" className={inputClass} placeholder="City" value={addr.city} onChange={(event) => setAddr({ ...addr, city: event.target.value })} />
                <input aria-label="State" className={inputClass} placeholder="State" value={addr.region} onChange={(event) => setAddr({ ...addr, region: event.target.value })} />
                <input aria-label="Postal code" className={inputClass} placeholder="Postal" value={addr.postal} onChange={(event) => setAddr({ ...addr, postal: event.target.value })} />
              </div>
            </fieldset>
          )}
          <p className="text-sm">Never: gift cards, protection plans, subscriptions, digital goods, money transfers, crypto.</p>
          <Button variant="seal" className="w-full" disabled={busy || agentId === ""} onClick={sign}>
            {busy ? "Waiting for your signature…" : "Sign this Writ"}
          </Button>
          {error === null ? null : <Problem error={error} />}
        </div>
      </Card>
    </Shell>
  );
}
