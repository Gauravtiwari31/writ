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
| `packages/core` | Canonical JSON (RFC 8785), SHA-256, minor-unit money, PayPal commitments, Writ and Cart schemas, taxonomy, passkey and device-key signatures, the deterministic policy engine and the monotonic combiner |
| `packages/ledger` | Hash-chained evidence ledger (one chain per Writ) and the evidence pack with offline verification checks |
| `packages/paypal` | Typed PayPal sandbox client (OAuth, Orders v2, Payments v2, Vault v3, Webhooks, Disputes), the only code allowed to move money |
| `packages/ai` | Model router (model ids from env), structured output with repair, datamarking, Channel3 client |
| `apps/gateway` | Fastify gateway: health, verified PayPal webhooks, Postgres schema and atomic budget reservations; decision pipeline and saga next |
| `scripts` | Day-1 spikes (plan §17) |
| `docs` | Spike runbook and results, daily scorecards |

## Status

Built and unit-tested: the core primitives (Writ schema and signatures, policy engine and combiner, evidence ledger, DB reservations) and the Day-1 spike scripts. **Nothing has run against the PayPal sandbox, Channel3, an LLM provider or Render yet.** The spikes in [`docs/SPIKES.md`](docs/SPIKES.md) are the next step, and every PayPal ID this project shows will come from those real sandbox runs.

## Development

Requires Node 22.12+ and pnpm 12.

```bash
pnpm install
```

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Copy `.env.example` to `.env` and fill in **sandbox** credentials only. Run a spike with `pnpm spike <file>.ts` (see [`docs/SPIKES.md`](docs/SPIKES.md)). The gateway's real-Postgres tests run when `TEST_DATABASE_URL` points at a disposable database.

## License

[MIT](LICENSE)
