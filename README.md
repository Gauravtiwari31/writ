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
| `packages/core` | Canonical JSON (RFC 8785), SHA-256, minor-unit money, PayPal commitments; Writ schema, signatures and the policy engine as they land |
| `packages/ledger` | Hash-chained evidence ledger and evidence pack |
| `packages/paypal` | Typed PayPal sandbox client, the only code allowed to move money |
| `packages/ai` | Model router and typed AI roles |
| `apps/gateway` | Fastify gateway: API, webhooks, decision pipeline, saga |
| `scripts` | Day-1 spikes (plan §17), seed and smoke scripts |
| `docs` | Spike results, architecture, daily scorecards |

## Development

Requires Node 22.12+ and pnpm 12.

```bash
pnpm install
```

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Copy `.env.example` to `.env` and fill in **sandbox** credentials only.

## License

[MIT](LICENSE)
