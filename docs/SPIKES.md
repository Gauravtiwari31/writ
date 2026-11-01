# Day-1 kill-risk spikes (plan §17)

Gate **G0**: Sun Nov 1, 23:00 IST. S1–S3 and S5–S8 must be PASS or have a fallback chosen; S4 closes by Mon Nov 2, 13:00 IST.

Run order: S5 → S7 → S1 → S8 → S3 → S2 (start early: disputes need waiting time) → S6 → S4.

| ID | Question | Status | Decision / fallback | Evidence (IDs, Debug-Ids) |
|---|---|---|---|---|
| S1 | Vault + merchant-initiated AUTHORIZE → capture and void in sandbox? | PENDING | | |
| S2 | Full dispute lifecycle on a Writ capture? | PENDING | | |
| S3 | Webhooks reach Render and verify? | PENDING | | |
| S4 | AG Studio + our data + custom widget + AI harness via our proxy? | PENDING | | |
| S5 | Which model for which role? | PENDING | | |
| S6 | Passkey signing over an arbitrary hash on the Render domain? | PENDING | | |
| S7 | Channel3 fits the hero? | PENDING | | |
| S8 | Do `custom_id` and capture `invoice_id` accept our commitments? | PENDING | | |

Every script prints a block between "paste into docs/SPIKES.md" markers. Paste it under the matching heading below and set the table row to PASS or FALLBACK with the reason and IDs. None of these has run live yet: there is no `.env` and nothing is deployed.

## Runbook

Run every command from the repo root.

### Step 0 (15 min)

1. Push `main` to the public GitHub repo. Render deploys `main`, and S3/S6 need the gateway on Render. Run `pnpm lint && pnpm typecheck && pnpm test` first (rule 42).
2. `cp .env.example .env` and fill values from your password manager. Sandbox credentials only (rule 21); never paste secrets in chat or git.
3. Any spike red for more than 2 h because of PayPal: post in the PayPal Discord with the `PayPal-Debug-Id` and a minimal repro, then switch to that spike's fallback (rule 6). Every script prints the debug ids.

### S5: which model for which role (1.5 h)

Prereqs: `GOOGLE_GENERATIVE_AI_API_KEY` (AI Studio), `GROQ_API_KEY`, `OPENROUTER_API_KEY` in `.env`. At least two model families.

```bash
pnpm spike spike-models.ts list
```

```bash
pnpm spike spike-models.ts bench --models google:<flash-lite id>,google:<flash id>,groq:<id>,openrouter:<id> --n 10
```

Copy model ids only from `list` output (rule 19). Add `--dry-run` to check the configuration without calling a model, and `--delay-ms 4000` if 429s dominate. PASS = "Verdict: PASS" (best model ≥ 98% JSON-valid and ≥ 90% field accuracy; verifier from a different family than the agents). Copy the printed `MODEL_*` lines into `.env` and fill the daily-quota blanks from each console. Fallback: other ids from `list`; a paid model only with an explicit OK.

### S7: Channel3 fits the hero? (1 h)

Prereqs: API key from trychannel3.com/developers with code `PAYPAL-HACKATHON-2026`; `CHANNEL3_API_KEY` in `.env`. Each search costs 1 credit.

```bash
pnpm spike spike-channel3.ts --dry-run
```

```bash
pnpm spike spike-channel3.ts
```

PASS = ≥ 80% of queries return price, image, merchant, category and URL, at least one unbranded handmade hero option within budget, latency p50/p95 printed. Raw responses land in `scripts/.out/channel3/`. Fallback: cached snapshots of real responses plus a refresh button (`GET /v1/products/{id}` is free). `scripts/.out` is git-ignored, so copy kept snapshots into a committed fixtures path.

### S1: Vault + merchant-initiated AUTHORIZE, capture and void (3 h)

Prereqs: a sandbox REST app (e.g. `writ-sandbox`) owned by the US business account "Writ Market", with **Vault** and **Transaction search** enabled under the app's advanced options; a US personal buyer "Ana" with a balance; `PAYPAL_ENV=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` in `.env`; port 8787 free (`--port` or `SPIKE_PORT` to change).

```bash
pnpm spike spike-vault.ts setup
```

Open the printed approve URL, log in as the **personal buyer** and approve. The script catches the return on `http://localhost:8787/return`, creates the payment token and saves `scripts/.out/vault.json`.

```bash
pnpm spike spike-vault.ts capture
```

```bash
pnpm spike spike-vault.ts void
```

`capture` authorizes $44.00 with `vault_id` and `stored_credential` MERCHANT/SUBSEQUENT/IMMEDIATE, captures exactly 44.00 with `final_capture` and `invoice_id`, and re-reads the order and capture. `void` authorizes and voids. PASS = both print "S1 …: PASS" with order, authorization, capture and void ids plus every debug id. If PayPal rejects `stored_credential`, re-run once with `capture --no-stored-credential`, record both and report it (rule 43). If the setup call rejects the `http://localhost` return URL, report the exact error rather than working around it. Fallback: supervised mode (each purchase uses the buyer's PayPal approval; "automatic when Agent Ready enables it").

### S8: `custom_id` / `invoice_id` round-trip (same capture run)

Nothing extra to run: `capture` checks that the order's `custom_id` is `writ:<short>:<40 hex>` matching C_pre and the capture's `invoice_id` is `wv-<40 hex>` matching C_post. FALLBACK (printed when only `custom_id` round-trips): `custom_id` only, C_post kept in the ledger.

### S3: webhooks reach Render and verify (1 h)

1. Render → New → Blueprint → this repo. It creates `writ-gateway` (`0.5c-512mb`, Node 22) and `writ-db` (`0.1c-256mb`, paid, never free). Enter `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` when prompted; leave `PAYPAL_WEBHOOK_ID` empty for now (deliveries get 503 and PayPal retries). Set a spend alert. Check `https://<host>/healthz` returns `{"ok":true,"service":"writ-gateway","env":"sandbox"}`. If the start fails with "pnpm/tsx not found", set the start command to `node --import tsx apps/gateway/src/server.ts`.
2. Set `GATEWAY_BASE_URL=https://<host>` in `.env`.
3. Register the webhook, then copy the printed `PAYPAL_WEBHOOK_ID` into Render and `.env` and redeploy:

```bash
pnpm spike spike-webhooks.ts register
```

4. Trigger a **real** event after registering, e.g. `pnpm spike spike-vault.ts capture` again (this fresh capture also feeds S2), then:

```bash
pnpm spike spike-webhooks.ts check
```

PASS = healthz 200, an unsigned POST rejected with 4xx, and at least one delivery with verification SUCCESS (Render log line "paypal webhook verification SUCCESS"). `simulate` proves reachability only: PayPal does not support postback verification for mock events. Fallback: polling job every 30 s.

### S2: full dispute lifecycle (2 h + waiting; start right after S3)

Prereqs: `PAYPAL_SANDBOX_BUYER_EMAIL` in `.env`; `scripts/.out/s1-capture.json` from the latest capture; gateway deployed with `ENABLE_SPIKES=true` for the RESOLVED-webhook check.

1. Try the API (expected to fail without the DISPUTE_CREATE scope; post the printed error and debug id in Discord): `pnpm spike spike-disputes.ts create --buyer-transaction-id <id from the BUYER's sandbox activity>`.
2. UI fallback: log in at sandbox.paypal.com as the buyer → Activity → the $44.00 payment → Report a problem (item not received).
3. Find the dispute, wait for actions (polls up to 20 min), then defend:

```bash
pnpm spike spike-disputes.ts find
```

```bash
pnpm spike spike-disputes.ts status --dispute-id PP-D-XXXX
```

```bash
pnpm spike spike-disputes.ts defend --dispute-id PP-D-XXXX
```

`defend` escalates an INQUIRY, then require-evidence → provide-evidence (JSON note + 1-page PDF as `input` + `file1`) → adjudicate SELLER_FAVOR → waits for RESOLVED and checks for a verified `CUSTOMER.DISPUTE.RESOLVED` at `/spikes/webhooks/recent`. If provide-evidence returns MISSING_OR_INVALID_REQUEST_BODY, rename the file part to `evidence-file` once and report it. PASS = "S2: PASS" with `RESOLVED_SELLER_FAVOR`. Fallback: create disputes in the sandbox UI before recording; automate only the response side.

### S6: passkey signs a Writ hash on the Render domain (1.5 h)

Prereqs: gateway on Render with `ENABLE_SPIKES=true` and `WEBAUTHN_RP_ID` set to the exact `onrender.com` host (redeploy after setting it); desktop Chrome; your phone.

```bash
pnpm spike spike-passkey.ts --self-test
```

1. Desktop Chrome: open `https://<host>/spikes/passkey/`, register a passkey, sign the Writ hash, run the tamper check.
2. Phone: open the same URL (or use the QR/hybrid flow from desktop), register and sign.
3. Open `https://<host>/spikes/passkey/report`; PASS needs desktop + phone signatures on the deployed origin plus the tamper check. Copy its `markdown` field.

Fallback: Ed25519 device key (WebCrypto, non-extractable, IndexedDB) labeled "device key". After G0 set `ENABLE_SPIKES=false` on Render.

### S4: AG Studio (3 h, closes Mon Nov 2, 13:00 IST; not scripted yet)

Obtain the AG Studio 45-day trial license (request on/after Nov 1 IST so it covers Dec 15; store as `NEXT_PUBLIC_AG_STUDIO_LICENSE_KEY`) and the `paypaldev/hackathon-paypal-ag-grid-boilerplate` repo. DoD: a dashboard renders 3 of our datasets with 1 custom widget, and the AI harness answers one prompt through `/api/ai/studio`; without a license the app shows a watermark, not a crash (rule 34). Fallbacks: Studio without the chat harness plus our own chat via the Studio Toolkit; last resort AG Grid Enterprise + AG Charts.

## S5 — models

## S7 — Channel3

## S1 — Vault + merchant-initiated payments

## S8 — PayPal anchoring fields

## S3 — Webhooks

## S2 — Disputes

## S6 — Passkeys

## S4 — AG Studio
