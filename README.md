# Writ

**Signed spending authority for AI agents, enforced on PayPal.**

Agents shop; Writ checks every cart against your passkey-signed limits before PayPal captures a cent, and defends disputes with the proof.

> **Status: in development** for the PayPal AI Hackathon ("Build What's Next with PayPal and AI", Oct 1 to Nov 12 2026). This README only describes what is in the repository today. The full design, scope and schedule are in [`plan.md`](plan.md).

## How it works (design)

1. A sentence like *"Get my sister a pottery-themed gift, under $60, arriving by Nov 20, ask me above $40"* compiles into a **Writ**: a structured mandate the user signs once with a passkey.
2. Any agent can shop inside that Writ, and only inside it.
3. Every agent payment goes through **two-key settlement on PayPal**: deterministic policy, then PayPal AUTHORIZE, then an independent verifier, then CAPTURE or VOID. LLM verdicts can only make a decision stricter.
4. Every purchase gets a hash-chained evidence record anchored inside the PayPal order (`custom_id`) and capture (`invoice_id`), used to answer disputes through the PayPal Disputes API.

## Repository layout

| Path | What it is |
|---|---|
| `packages/core` | Canonical JSON (RFC 8785), SHA-256, minor-unit money, PayPal commitments, Writ and Cart schemas, taxonomy, passkey and device-key signatures, the policy engine and monotonic combiner, the HTTP contract |
| `packages/ledger` | Hash-chained evidence ledger and the evidence pack with offline verification checks |
| `packages/paypal` | Typed PayPal sandbox client (OAuth, Orders v2, Payments v2, Vault v3, Webhooks, Disputes), the only code allowed to move money |
| `packages/ai` | Model router, Intent Compiler, Sentinel, Verifier, Reader, Dispute Analyst, datamarking, Channel3 client |
| `packages/agents` | Atlas (naive) and Scout (hardened) reference agents, the agent API client, the page reader with SSRF rules |
| `apps/gateway` | Fastify gateway: Writ lifecycle, agent API, decision pipeline, payment saga and recovery, approvals, webhooks, evidence, disputes, judge mode, console data |
| `apps/web` | Next.js Wallet, AG Studio console, fixture pages |
| `evals` | WritBench-lite: cases, runner, results, report ([docs/EVALS.md](docs/EVALS.md)) |
| `fixtures` | Security test fixtures: fake attack pages, labeled and `noindex` |
| `scripts` | Day-1 spikes, local launcher, smoke test |
| `docs` | Architecture, spike runbook, evals, daily scorecards |

## Status

Built and tested end to end with PayPal faked at the HTTP boundary in unit tests only: the hero path through real routes, the payment saga with its chaos cases, approvals, evidence packs, disputes, judge mode. The hijack is blocked with $0 moved and its hidden text flagged, live in a browser.

**Not verified yet:**

- Nothing has run against the real PayPal sandbox, an LLM provider, Channel3 or Render: that needs keys (spikes in [`docs/SPIKES.md`](docs/SPIKES.md)). Every PayPal ID this project shows will come from those real runs.
- The agent hijack rate in WritBench needs a model.
- The concurrency proofs have only run on embedded Postgres, which serializes statements. They count once run on real Postgres with `TEST_DATABASE_URL`.
- The passkey ceremony in the Wallet has not been exercised on a real authenticator (spike S6).
- Not built yet: Connect PayPal with JS SDK v6 (the approve-URL flow is there), custom AG Studio widgets, theme and AI harness (S4).

## Development

Requires Node 22.12+ and pnpm 12.

```bash
pnpm install
```

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Run it locally, with no accounts or keys, on embedded Postgres (Wallet on port 3000, gateway on 10000):

```bash
pnpm dev
```

```bash
pnpm smoke:local
```

```bash
pnpm eval --mode rules
```

Copy `.env.example` to `.env` and fill in **sandbox** credentials only. Run a spike with `pnpm spike <file>.ts` (see [`docs/SPIKES.md`](docs/SPIKES.md)). The gateway's real-Postgres tests run when `TEST_DATABASE_URL` points at a disposable database.

## License

[MIT](LICENSE)
