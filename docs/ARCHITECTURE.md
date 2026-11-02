# Writ architecture and parallel-build contract

> Source of truth for *how the code is split*. `plan.md` stays the source of truth for *what* we build and why; read its §0, §5 and §22 first. This document freezes the module boundaries, file ownership and cross-stream contracts so the build streams (§2) can work **in parallel in one working tree** without editing the same file.
>
> Scope now: **P0 only** (plan §22 rule 3). Out of scope until G2: writ-mcp (P1-1), shipment tracking (P1-4), writ-verify CLI (P1-5), reconciliation, gateway attestation, Agent Toolkit tools, Kernel, WebMCP.

## 1. Module map

```text
packages/core     @writ/core       pure, isomorphic: Writ/Cart schemas, taxonomy, ids, JCS + SHA-256, money,
                                   commitments, policy engine + combiner, purchase state machine data,
                                   approval / verification / dispute documents, ProductFacts, CatalogItem
                  @writ/core/api   the HTTP contract (request/response DTOs, SSE events) shared by gateway,
                                   Wallet, console and agents
                  @writ/core/signatures  passkey + device-key verification (server weight; never in the Wallet bundle)
packages/ledger   @writ/ledger     hash chain per Writ, evidence pack JSON + verifyEvidencePack
packages/paypal   @writ/paypal     typed sandbox client: the ONLY code that moves money (§22 rule 8)
packages/ai       @writ/ai         model router, generateStructured (repair + fallback), datamarking, Channel3,
                                   AI roles (Compiler, Sentinel, Verifier, Reader, Analyst) behind roles/types.ts
packages/agents   @writ/agents     Atlas (naive) + Scout (hardened), AgentApiClient (public agent API), PageReader
apps/gateway      @writ/gateway    Fastify API + SSE, decision pipeline, saga, outbox jobs, webhooks, disputes,
                                   evidence, console data, judge mode, built-in agent runs
apps/web          @writ/web        Next.js App Router: Wallet, AG Studio console (/console), /fixtures route
evals             @writ/evals      WritBench-lite cases, runner, metrics, README table generator
scripts           @writ/scripts    Day-1 spikes, `pnpm dev` launcher, `pnpm smoke:local`
fixtures/         (data)           Deals Outlet security test fixture pages + catalog
```

Dependency direction (no cycles): `core ← ledger, paypal, ai ← agents ← gateway ← evals`; `web → core, ledger`; `scripts → core, ai, paypal, agents`.

Runtime picture (decisions of Nov 1, recorded in plan §6.9):

```text
Browser ──► Wallet origin (APP_BASE_URL, Next.js) ──/gw/*──► gateway (GATEWAY_BASE_URL)
            WebAuthn runs here (RP ID = Wallet host)          verifies passkeys (expectedOrigin = APP_BASE_URL)
            session cookie is first-party here                Postgres (Render) or PGlite (local)
External agent ───────────────────────── Bearer wak_… ──────► /v1/agent/*
Built-in Atlas/Scout (in the gateway process) ── Bearer ─────► /v1/agent/* via GATEWAY_INTERNAL_URL (loopback)
PayPal sandbox ◄── only saga / dispute job handlers, after COMMIT       PayPal webhooks ──► /v1/webhooks/paypal
```

## 2. Streams and file ownership

Every file has exactly one owner. A stream edits **only** its own files. "Frozen" files are owned by the architect; a stream that needs a change there stops, writes the request (file, exact change, why) into its final summary, and works inside its own files meanwhile. Nobody edits `plan.md`: report the plan change you need. Additive changes to a stream-owned contract file are allowed (new optional fields, new exports with domain-prefixed names); renaming, removing or narrowing anything another stream consumes is not.

### 2.1 Frozen (architect)

| Path | Why frozen |
|---|---|
| root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, every workspace `package.json` and `tsconfig.json`, `tsconfig.base.json`, `eslint.config.js`, `.gitignore`, `.gitattributes`, `.env.example`, `render.yaml` | dependencies and toolchain were installed in one pass (§11) |
| `plan.md`, `CLAUDE.md`, `AGENTS.md`, `LICENSE`, `docs/ARCHITECTURE.md`, `docs/SPIKES.md`, `docs/scorecard/**` | process documents |
| `packages/core/**` except the stream-owned `src/api/*.ts` files in §2.2 (and their own new tests) | shared domain contracts; `src/api/common.ts`, `src/api/meta.ts`, `src/api/events.ts`, `src/api/index.ts`, `test/api.test.ts`, `test/contracts.test.ts` included |
| `packages/ledger/**` | hash chain + evidence pack format |
| `packages/ai/src/roles/types.ts` | AI role contracts |
| `packages/agents/src/types.ts` | agent ↔ runner contract |
| `apps/gateway/src/{app,server,index,config,deps,services}.ts`, `src/{auth,contracts,db,events,http,tx,budget,spikes}/**`, `src/routes/{table,health,meta}.ts`, `drizzle/**`, `drizzle.config.ts`, `vitest.config.ts` | gateway skeleton, schema (no stream changes the schema), shared infrastructure |
| `apps/gateway/test/{db,reservation,server,passkey-spike,config,auth,unit-of-work,routes,local-run,views}.test.ts`, `apps/gateway/test/helpers/**` | infrastructure tests and shared helpers |
| `apps/web/{package.json,next.config.ts,tsconfig.json,postcss.config.mjs,vitest.config.ts}` | web toolchain, `/gw` rewrite |
| `scripts/spike-*.ts`, `scripts/lib/**` | Day-1 spike tools (plan §17) and the shared env loader `scripts/dev.ts` uses |

Frozen **signatures** inside stream-owned files (the body is the stream's): `createPurchaseSaga`, `sagaJobs` (src/saga/index.ts), `createJobRunner` (src/jobs/index.ts), `createAgentRunner` (src/runs/index.ts), `createRateLimits` (src/judge/index.ts), `disputeJobs` (src/disputes/index.ts), `writJobs` (src/writs/index.ts), `createAiRuntime`, `createCompiler`, `createSentinel`, `createVerifier`, `createReader`, `createAnalyst` (packages/ai/src/roles), `createAtlas`, `createScout`, `createPageReader` and the public methods of `AgentApiClient` (packages/agents).

### 2.2 Stream ownership

| Stream | Owns (globs) |
|---|---|
| **money** (P0-5, P0-6, P0-8) | `apps/gateway/src/{saga,jobs,approvals,webhooks}/**`, `apps/gateway/src/routes/{approvals,webhooks}.ts`, `apps/gateway/test/money/**`, `apps/gateway/test/webhook.test.ts`, `packages/paypal/**` (backward-compatible changes only: evidence and web-flows consume it), `packages/core/src/api/approvals.ts`, `packages/core/test/api-approvals.test.ts` |
| **api** (P0-1 server, P0-3 gateway side, P0-4) | `apps/gateway/src/{pipeline,writs,identity,catalog,agent-api,purchases}/**`, `apps/gateway/src/routes/{auth,writs,agents,agent-api,purchases,stream}.ts`, `apps/gateway/test/api/**`, `packages/core/src/api/{auth,writs,agents,agent-api,purchases}.ts`, `packages/core/test/api-{auth,writs,agents,agent-api,purchases}.test.ts` |
| **ai** (P0-1 compiler, P0-3 reader, P0-4 sentinel + verifier, P0-9 analyst) | `packages/ai/**` except `src/roles/types.ts`, `package.json`, `tsconfig.json` |
| **agents** (P0-3) | `packages/agents/**` except `src/types.ts`, `package.json`, `tsconfig.json`; `apps/gateway/src/runs/**`, `apps/gateway/src/routes/runs.ts`, `apps/gateway/test/agents/**`, `fixtures/deals-outlet/**`, `packages/core/src/api/runs.ts`, `packages/core/test/api-runs.test.ts` |
| **evidence** (P0-7 rest, P0-9) | `apps/gateway/src/{evidence,disputes}/**`, `apps/gateway/src/routes/{evidence,disputes}.ts`, `apps/gateway/test/evidence/**`, `packages/core/src/api/{evidence,disputes}.ts`, `packages/core/test/api-{evidence,disputes}.test.ts` |
| **web-foundation** (P0-10, first among web streams) | `apps/web/src/app/{layout.tsx,globals.css,not-found.tsx,error.tsx,global-error.tsx,loading.tsx}`, `apps/web/src/{components,lib,styles}/**`, `apps/web/public/**` |
| **web-wallet** (P0-10, P0-1 UI, P0-6 UI) | `apps/web/src/app/page.tsx`, `apps/web/src/app/{signin,home,writs,approvals,agents}/**`, `apps/web/src/features/wallet/**` |
| **web-flows** (P0-2, P0-10) | `apps/web/src/app/{connect,runs,receipts,disputes,fixtures}/**`, `apps/web/src/features/flows/**`, `apps/gateway/src/paypal-connect/**`, `apps/gateway/src/routes/paypal.ts`, `apps/gateway/test/web-flows/**`, `packages/core/src/api/paypal.ts`, `packages/core/test/api-paypal.test.ts` |
| **console** (P0-11) | `apps/web/src/app/console/**`, `apps/web/src/features/console/**`, `apps/gateway/src/console/**`, `apps/gateway/src/routes/console.ts`, `apps/gateway/test/console/**`, `packages/core/src/api/console.ts`, `packages/core/test/api-console.test.ts` |
| **judge** (P0-13) | `apps/gateway/src/judge/**`, `apps/gateway/src/routes/demo.ts`, `apps/gateway/test/judge/**`, `apps/web/src/app/judge/**`, `scripts/dev.ts`, `scripts/smoke-local.ts`, `scripts/seed*.ts`, `README.md`, `docs/JUDGES.md`, `packages/core/src/api/demo.ts`, `packages/core/test/api-demo.test.ts` |
| **bench** (P0-12) | `evals/**` except `package.json`, `tsconfig.json`; `docs/EVALS.md` |

Web streams import shared UI only from `apps/web/src/components` and `apps/web/src/lib` (web-foundation). Until web-foundation lands, their placeholder pages are self-contained. Everything a web stream needs from the gateway goes through web-foundation's typed client (`apps/web/src/lib/api`), built on `@writ/core/api`. Every API lives on the gateway and the browser reaches it as `/gw/<path>` (the console's AG Studio adapter included: `/gw/api/ai/studio`); the only Next.js route handler is the `/fixtures/deals-outlet` route (web-flows).

Paths no stream owns yet (`docs/SECURITY.md`, `docs/WRIT-SPEC.md`, `packages/mcp`, `packages/verify-cli`) are P1 or later; creating them is an architect change.

### 2.3 Keeping one shared tree green

- Before handing back: `pnpm lint && pnpm typecheck && pnpm test` (rule 42), and `pnpm --filter @writ/web build` for any change under `apps/web` or in a package the Wallet imports (`@writ/core`, `@writ/ledger`). Never leave a failing test in the tree; never weaken or delete one (rule 41). `pnpm --filter @writ/core test:coverage` must keep `src/policy/**` at 100 %.
- Tests share the machine with every other stream's suite: keep each test well under Vitest's 5 s default by fixing slow paths, never by raising a timeout to hide one. Expensive one-time setup (PGlite boot, migrations, module warm-up) goes in `beforeAll` (hook timeout 60 s); assert many cheap checks by collecting mismatches and asserting once, not with thousands of `expect()` calls.
- Stop every server or watcher you start (`pnpm dev`, `next dev`, `tsx watch`, `next start`) and its child processes before handing back.
- New tests go in the stream's own test folder. Shared helpers: `apps/gateway/test/helpers/app.ts` (`buildTestApp`, `createTestDb`, `testConfig`): in-memory PGlite with migrations, no network.
- PayPal is never called for real in tests; a fetch fake or `ServiceOverrides.paypal` is allowed only in unit tests and `evals/` (rule 41). AI roles are tested with AI SDK `MockLanguageModelV4` (`ai/test`).
- Contracts are typed; a stream codes against the interface and tests with a fake of the other side (e.g. the pipeline against a fake `PurchaseSaga`).

## 3. Cross-stream contracts

Every contract below is in a frozen file. Signatures are quoted from the code.

### 3.1 Services container — `apps/gateway/src/deps.ts`

Each route plugin reads `app.services`; stream modules receive `CoreServices` (plus what they need).

```ts
interface CoreServices {
  config: GatewayConfig;               // src/config.ts (secrets only via config.secrets.*())
  db: AppDb | null;                    // requireDb(services) → 503 database_unavailable when null
  clock: () => Date;
  ids: (kind: RowKind) => string;      // newRowId with the injected clock
  log: FastifyBaseLogger;
  events: EventBus;                    // src/events/bus.ts
  uow: UnitOfWork;                     // src/tx/unit-of-work.ts — the ONLY way to write state + ledger + outbox
  sessions: SessionManager;            // src/auth/session.ts
  paypal: PayPalClients | null;        // { http, multipart, clientId, webhookId, buyerEmail }; null = unconfigured
  ai: AiRuntime;                       // packages/ai/src/roles/types.ts
  channel3: ProductSearch | null;      // { search(request) }; null = CHANNEL3_API_KEY unset
  pages: PageReader;                   // packages/agents/src/types.ts: the ONE fetcher of untrusted web pages (SSRF rules)
  limits: RateLimits;                  // src/contracts/limits.ts
}
interface Services extends CoreServices { saga: PurchaseSaga; runs: AgentRunner; jobs: JobRunner }
type ServiceOverrides = Partial<Pick<Services, "clock" | "ids" | "events" | "paypal" | "ai" | "channel3" | "pages" | "limits" | "saga" | "runs" | "jobs">>;
function requireDb(services: Pick<CoreServices, "db">): AppDb;
```

`createServices(config, { db, log, overrides })` in `src/services.ts` wires them; `buildApp(config, { db, services: overrides, logger, verifyWebhook, webhookDedupe })` in `src/app.ts` decorates `app.services` and registers every plugin. `services.pages = createPageReader({ allowedOrigins: [config.appBaseUrl] })` (the agents stream implements it; until then `read` rejects with `NotImplementedError`, which callers treat as a failed fetch). Both the built-in agents' `read_page` tool and the pipeline's Sentinel stage fetch through it, never through a raw `fetch`. `FIXTURES_DIR` (`src/config.ts`) is `<repo>/fixtures`, where the fixture sites live (`fixtures/<site>/catalog.json` + pages); the gateway runs from the repo checkout locally and on Render.

Routes validate with Zod only (`parseWith(schema, value)` from `src/http/errors.ts`, schemas from `@writ/core/api`); nobody declares a Fastify JSON `schema`. `buildApp` passes `lazySchemaController()` (`src/http/fastify.ts`), so Fastify's ajv / fast-json-stringify compilers are loaded only if a route ever declares one (profiled: ~190 ms off every cold start and off the first test of every file).

### 3.2 Unit of work — `apps/gateway/src/tx/unit-of-work.ts` (§22 rule 14)

```ts
interface TxContext {
  readonly db: Db;            // the open transaction
  readonly tenantId: string;
  readonly now: Date;         // one clock reading per transaction (ledger ts)
  lockWrit(writId: string): Promise<void>;                       // FOR UPDATE; 404 outside the tenant
  appendLedger(input: { writId: string; purchaseId?: string | null; type: LedgerEventType; payload: JsonObject }): Promise<LedgerEvent>;
  enqueue<T extends OutboxTopic>(input: { topic: T; payload: OutboxPayload<T>; availableAt?: Date; dedupeKey?: string }): Promise<string | null>;
  emit(event: StreamEvent): void;                                 // published after COMMIT
}
interface UnitOfWork { run<T>(tenantId: string, fn: (ctx: TxContext) => Promise<T>): Promise<T> }
```

- One `run` = one transaction: state update(s) + `appendLedger` + `enqueue` + `emit`. Nothing leaves the process before COMMIT; a rollback emits nothing. `appendLedger` also emits `ledger.appended`.
- Lock order: `writs` row (`lockWrit`, also taken by `appendLedger`) → `writ_budgets` → `purchases` → `approvals`. Deadlocks, serialization failures and a lost ledger race are retried, so the callback must do DB work only (no PayPal, no model, no fetch).
- Helpers: `ledgerEventFromRow`, `ledgerEventView`, `loadChain(db, writId)` in `src/tx/ledger.ts`.
- Budget operations (`src/budget/reservations.ts`, call inside the same `run` as the purchase transition): `reserveBudget`, `settleReservation`, `releaseReservation`, `reverseSettlement`, `getBudget`, `policyBudgetOf(row)` (feeds the policy engine `orders_count = orders_count + held_orders`).

### 3.3 Purchase saga — `apps/gateway/src/contracts/saga.ts` (money implements in `src/saga`)

```ts
interface PurchaseSaga {
  open(input: OpenPurchaseInput): Promise<{ purchase: PurchaseSnapshot; replayed: boolean }>;
  block(input: { tenantId: string; purchaseId: string; reason: "policy_blocked" | "budget_exhausted"; detail: string; policy: PolicyDecision | null }): Promise<PurchaseSnapshot>;
  reserveAndAuthorize(input: { tenantId: string; purchaseId: string; policy: PolicyDecision; waitMs?: number }): Promise<PurchaseSnapshot>;
  beginVerification(input: { tenantId: string; purchaseId: string }): Promise<PurchaseSnapshot>;
  execute(input: { tenantId: string; purchaseId: string; verification: VerificationRecord; decisionId: string; waitMs?: number }): Promise<PurchaseSnapshot>;
  requestVoids(ctx: TxContext, input: { writIds: readonly string[]; reason: "kill_switch" | "writ_revoked" | "writ_expired" }): Promise<string[]>;
  markDisputed(ctx: TxContext, input: { purchaseId: string; paypalDisputeId: string }): Promise<void>;
  resolveDispute(ctx: TxContext, input: { purchaseId: string; paypalDisputeId: string; outcome: "WON" | "LOST" }): Promise<void>;
  get(input: { tenantId: string; purchaseId: string }): Promise<PurchaseSnapshot | null>;
}
```

Callers: the decision pipeline (api: `open`, `block`, `reserveAndAuthorize`, `beginVerification`, `execute`), Writ revoke / kill switch / expiry sweep (api: `requestVoids` inside their own `uow.run`), the dispute engine (evidence: `markDisputed`, `resolveDispute` inside its `uow.run`). Approvals are money-internal.

Pipeline order (plan §6.2, api orchestrates; decisions row per stage):

1. `schema`: re-parse the stored cart with `CartSchema`; failure → `saga.block(policy_blocked)`.
2. `saga.open` (Idempotency-Key replay → return the stored outcome, nothing re-runs).
3. `policy` (+ Writ validity: `verifyWritSignature`, status, expiry, agent binding) via `evaluatePolicy` with `policyBudgetOf(budget)`; `threshold` row from `previewVerdict`. BLOCK → `saga.block` → HTTP 403.
4. `reserve` + `authorize`: `saga.reserveAndAuthorize`; rows written from the returned snapshot (BLOCKED budget_exhausted → 403; FAILED → 200 with `state_reason`).
5. `saga.beginVerification`, then `sentinel` (each `page` source fetched through `services.pages`, listings scanned as text; one row, one `attacks` row per flagged source, `SENTINEL_SCANNED` per source; a source that cannot be fetched or scanned is a `{status:"error"}` signal → REVIEW) and `verifier` (typed facts only).
6. `combiner`: `combineDecision` → build the `VerificationRecord` (core `verification.ts`), store it as the combiner row's `output` with `output_hash = H_verifier`, then `saga.execute`.

### 3.4 Durable jobs — `apps/gateway/src/contracts/jobs.ts` (money implements the runner in `src/jobs`)

```ts
const OUTBOX_TOPICS = ["purchase.authorize", "purchase.capture", "purchase.void", "purchase.refund",
                       "approval.expire", "paypal.webhook", "dispute.sync", "dispute.execute"] as const;
interface OutboxJob<T extends OutboxTopic> { id; tenantId; topic: T; payload: OutboxPayload<T>; attempts: number; createdAt: Date }
type JobOutcome = { status: "done" } | { status: "retry"; error: string; delayMs?: number } | { status: "dead"; error: string };
type JobHandler<T> = (job: OutboxJob<T>) => Promise<JobOutcome>;
interface PeriodicTask { name: string; intervalMs: number; run(): Promise<void> }
interface JobRegistration { handlers: { [T in OutboxTopic]?: JobHandler<T> }; periodic: readonly PeriodicTask[] }
interface JobRunner { start(): void; stop(): Promise<void>; kick(): void; runDue(limit?: number): Promise<number> }
```

Payloads are Zod-validated at enqueue (`OUTBOX_PAYLOAD_SCHEMAS`). See §6 for producers and handlers.

### 3.5 Agent runs — `apps/gateway/src/contracts/runs.ts` (agents implements in `src/runs`)

```ts
interface StartRunInput { tenantId: string; userId: string; agentKind: "atlas" | "scout"; writId: string; goal?: string; mode: "manual" | "hero" }
interface AgentRunner {
  start(input: StartRunInput): Promise<RunView>;
  stop(input: { tenantId: string; runId: string }): Promise<RunView>;
  recoverOnStartup(): Promise<void>;   // server.ts: QUEUED/RUNNING left by a dead process → FAILED (interrupted)
  shutdown(): Promise<void>;           // server.ts on SIGTERM
}
```

`packages/agents/src/types.ts`:

```ts
interface AgentRunContext { writId: string; goal: string; signal: AbortSignal; emit(event: RunEvent): Promise<void>; consumeLlmCall(): Promise<boolean> }
interface AgentRunResult { status: "SUCCEEDED" | "FAILED" | "CANCELLED"; failure_code: RunFailureCode | null; failure_detail: string | null; purchase_id: string | null; steps: number; tokens: number }
interface ShoppingAgent { readonly kind: "atlas" | "scout"; run(context: AgentRunContext): Promise<AgentRunResult> }
interface PageReader { read(url: string, signal?: AbortSignal): Promise<{ url: string; status: number; html: string; fetched_at: string }> }
createAtlas(deps: { models; client: AgentApiClient; pageReader: PageReader; maxSteps? }): ShoppingAgent
createScout(deps: AtlasDeps & { reader: Reader }): ShoppingAgent
```

The runner mints a fresh key for the built-in agent at run start (`mintAgentKey`, `UPDATE agents SET api_key_hash, key_hint`), keeps it in memory, and builds `new AgentApiClient({ baseUrl: config.gatewayInternalUrl, apiKey })`. One active run per built-in agent. The agents get `services.pages` as their PageReader. `createPageReader` (agents stream) runs in the gateway process: http(s) only, refuse private/loopback/link-local targets except the `allowedOrigins` (`config.appBaseUrl`: fixture pages in local runs), re-check every redirect target, cap size (1 MB) and time (10 s).

`AgentApiClient` (`packages/agents/src/client.ts`, implemented): `listWrits()`, `getWrit(id)`, `search(req)`, `getProduct(ref)`, `proposeCart(req)`, `checkout(req, idempotencyKey) → { httpStatus, result }` (403 BLOCK is a typed answer), `getPurchase(id)`. Used by the built-in agents, `scripts/smoke-local.ts` (external agent over HTTP) and WritBench.

### 3.6 AI roles — `packages/ai/src/roles/types.ts`

```ts
type RoleResult<T> = { ok: true; value: T; meta: RoleMeta } | { ok: false; failure: { kind: FailureKind | "unavailable" | "budget_exceeded"; message: string }; meta: RoleMeta };
interface Compiler { compile(input: CompileInput): Promise<RoleResult<WritDraft>> }
interface Sentinel { scan(input: SentinelInput): Promise<SentinelScan> }      // signal: SentinelSignal (core combiner)
interface Verifier { verify(input: VerifierInput): Promise<VerifierRun> }     // signal: VerifierSignal; typed fields only
interface Reader { read(input: ReaderInput): Promise<RoleResult<ProductFacts>> }
interface Analyst { analyze(input: AnalystInput): Promise<RoleResult<DisputeAnalysis>> }
interface AiRuntime { compiler: Compiler | null; sentinel: Sentinel; verifier: Verifier | null; reader: Reader | null;
                      analyst: Analyst | null; agentModels: readonly ResolvedModel[] | null; status: Record<Role, RoleStatus> }
createAiRuntime(options: { env: RouterEnv; factories?; now?: () => Date; beforeModelCall?: () => Promise<boolean> }): AiRuntime
```

Roles never throw for model or transport problems; the stubs throw `NotImplementedError` until the ai stream lands, and every caller treats a throw as a failure (fail closed).

### 3.7 Rate limits — `apps/gateway/src/contracts/limits.ts` (judge implements in `src/judge`)

```ts
interface RateLimits {
  tryConsumeHeroRun(tenantId: string): Promise<{ allowed: boolean; remaining: number }>;
  heroRunsRemaining(tenantId: string): Promise<number>;
  tryConsumeLlmCall(): Promise<boolean>;   // passed to createAiRuntime as beforeModelCall; the runner calls it per agent step
  llmCallsRemaining(): Promise<number>;
}
```

Backed by `rate_counters` (one atomic upsert per increment). The stub allows everything (no limits exist yet).

### 3.8 Shared documents — `packages/core`

| File | Exports | Used by |
|---|---|---|
| `src/purchase.ts` | `PURCHASE_STATES`, `PURCHASE_TRANSITIONS`, `canTransition`, `isTerminalPurchaseState`, `VOIDABLE_PURCHASE_STATES`, `RECOVERABLE_PURCHASE_STATES`, `MONEY_HELD_STATES`, `PURCHASE_STATE_REASONS`, `DECISION_RECORD_STAGES`, `APPROVAL_STATUSES`, `APPROVAL_TIMEOUT_MS` | money, api, web, console |
| `src/product.ts` | `CatalogItemSchema`, `FixtureCatalogSchema` (`fixtures/<site>/catalog.json`), `ProductFactsSchema`, `factText` | api (search, carts), agents (fixtures, Reader), ai (Verifier) |
| `src/approval.ts` | `ApprovalRequestSchema`, `ApprovalBodySchema`, `approvalBody(request, decision)`, `approvalHash(body)` (= WebAuthn challenge), `ApprovalRecordSchema`, `approvalRecordHash` (= H_approval) | money, web-wallet, evidence |
| `src/verification.ts` | `VerificationRecordSchema`, `verificationRecordHash` (= H_verifier), `StageContributionSchema` | api (builds), money (C_post), evidence (pack) |
| `src/dispute.ts` | `DisputeAnalysisSchema`, `canAutoExecute`, `ANALYST_UNAVAILABLE`, `DISPUTE_LIABILITIES`, `DISPUTE_ACTIONS` | ai (analyst), evidence |
| `src/signatures/convert.ts` | `webauthnSignatureFromResponse(browserAssertion)` | web-wallet (Writ signing, approvals) |
| `src/errors.ts` | `NotImplementedError`, `isNotImplementedError` | every stub; the gateway maps it to 501 |
| `src/api/*` | DTOs per route (§4) and `StreamMessage` (§7) | gateway routes, web lib/api, agents client |

Ledger event vocabulary (`packages/ledger/src/events.ts`, appended Nov 1): `WRIT_SIGNED, WRIT_REVOKED, WRIT_EXPIRED, CART_PROPOSED, POLICY_DECIDED, PURCHASE_BLOCKED, BUDGET_RESERVED, PAYPAL_ORDER_CREATED, PAYPAL_AUTHORIZED, PURCHASE_FAILED, SENTINEL_SCANNED, VERIFIER_DECIDED, HUMAN_REVIEW_REQUESTED, HUMAN_APPROVED, HUMAN_DECLINED, HUMAN_REVIEW_EXPIRED, PAYPAL_CAPTURED, PAYPAL_CAPTURE_FAILED, PAYPAL_VOIDED, BUDGET_SETTLED, BUDGET_RELEASED, TRACKING_ADDED, DISPUTE_OPENED, DISPUTE_UPDATED, DISPUTE_ANALYZED, DISPUTE_EVIDENCE_SUBMITTED, DISPUTE_CLAIM_ACCEPTED, DISPUTE_RESOLVED, REFUNDED, KILL_SWITCH`. Who appends which: §5.

## 4. Gateway route table

Source: `apps/gateway/src/routes/table.ts` (asserted by `test/routes.test.ts`). Schemas are in `@writ/core/api`. Errors always use `ApiError { error, message, details? }` (`src/http/errors.ts`). Every stub answers `501 not_implemented` naming its owner. The browser calls these through the Wallet as `/gw/<path>`.

| Method | Path | Caller | Auth | Request | Response | Owner |
|---|---|---|---|---|---|---|
| GET | `/healthz` | Render | none | – | `HEALTH_BODY` | architect ✓ |
| GET | `/v1/meta` | Wallet | none | – | `MetaResponse` | architect ✓ |
| POST | `/v1/auth/register/options` | Wallet | none | `RegisterOptionsRequest` | `RegisterOptionsResponse` | api |
| POST | `/v1/auth/register/verify` | Wallet | none | `RegisterVerifyRequest` | `SessionView` + cookie | api |
| POST | `/v1/auth/login/options` | Wallet | none | – | `LoginOptionsResponse` | api |
| POST | `/v1/auth/login/verify` | Wallet | none | `LoginVerifyRequest` | `SessionView` + cookie | api |
| POST | `/v1/auth/logout` | Wallet | session | – | 204, cookie cleared | api |
| GET | `/v1/me` | Wallet | session | – | `MeResponse` | api |
| POST | `/v1/auth/device-keys` | Wallet | session | `RegisterDeviceKeyRequest` | `DeviceKeyView` | api |
| GET | `/v1/address-book` | Wallet | session | – | `AddressListResponse` | api |
| POST | `/v1/address-book` | Wallet | session | `CreateAddressRequest` | `AddressDetail` | api |
| POST | `/v1/writs/compile` | Wallet | session | `CompileRequest` | `CompileResponse` (503 `ai_unavailable`) | api |
| POST | `/v1/writs` | Wallet | session | `CreateWritRequest` | `CreateWritResponse` | api |
| GET | `/v1/writs` | Wallet | session | – | `ListWritsResponse` | api |
| GET | `/v1/writs/:id` | Wallet | session | – | `WritView` | api |
| POST | `/v1/writs/:id/sign` | Wallet | session | `SignWritRequest` | `WritView` | api |
| POST | `/v1/writs/:id/revoke` | Wallet | session | `RevokeWritRequest` | `WritView` | api |
| POST | `/v1/kill-switch` | Wallet | session | `KillSwitchRequest` | `KillSwitchResponse` | api |
| POST | `/v1/agents` | Wallet | session | `CreateAgentRequest` | `CreateAgentResponse` (key once) | api |
| GET | `/v1/agents` | Wallet | session | – | `ListAgentsResponse` | api |
| POST | `/v1/agents/:id/revoke` | Wallet | session | – | `AgentView` | api |
| POST | `/v1/agents/:id/rotate-key` | Wallet | session | – | `CreateAgentResponse` | api |
| GET | `/v1/agent/writs` | Agent | agent key | – | `AgentWritListResponse` | api |
| GET | `/v1/agent/writs/:id` | Agent | agent key | – | `AgentWritView` | api |
| POST | `/v1/agent/search` | Agent | agent key | `AgentSearchRequest` | `AgentSearchResponse` | api |
| GET | `/v1/agent/products/:ref` | Agent | agent key | – | `AgentProductResponse` | api |
| POST | `/v1/agent/carts` | Agent | agent key | `ProposeCartRequest` | `ProposeCartResponse` | api |
| POST | `/v1/agent/checkout` | Agent | agent key + `Idempotency-Key` | `CheckoutRequest` | `CheckoutResponse` (403 when BLOCKED) | api |
| GET | `/v1/agent/purchases/:id` | Agent | agent key | – | `AgentPurchaseView` | api |
| GET | `/v1/purchases` | Wallet/Console | session | – | `ListPurchasesResponse` | api |
| GET | `/v1/purchases/:id` | Wallet/Console | session | – | `PurchaseDetailResponse` | api |
| GET | `/v1/stream` | Wallet/Console | session | – | SSE `StreamMessage` | api |
| GET | `/v1/approvals` | Wallet | session | – | `ListApprovalsResponse` | money |
| GET | `/v1/approvals/:id` | Wallet | session | – | `ApprovalChallengeResponse` | money |
| POST | `/v1/approvals/:id/decide` | Wallet | session | `DecideApprovalRequest` | `DecideApprovalResponse` | money |
| POST | `/v1/webhooks/paypal` | PayPal | PayPal signature | raw event | `{ received, event_id }` | money |
| GET | `/v1/paypal/config` | Wallet | session | – | `PayPalConfigResponse` | web-flows |
| GET | `/v1/paypal/vault` | Wallet | session | – | `VaultStatusView` | web-flows |
| POST | `/v1/paypal/vault/setup-token` | Wallet | session | `CreateSetupTokenRequest` | `CreateSetupTokenResponse` | web-flows |
| POST | `/v1/paypal/vault/payment-token` | Wallet | session | `CreatePaymentTokenRequest` | `VaultStatusView` | web-flows |
| POST | `/v1/paypal/vault/disconnect` | Wallet | session | – | `VaultStatusView` | web-flows |
| POST | `/v1/runs` | Wallet | session | `StartRunRequest` | `RunView` (202) | agents |
| GET | `/v1/runs` | Wallet | session | – | `ListRunsResponse` | agents |
| GET | `/v1/runs/:id` | Wallet | session | – | `RunDetailResponse` | agents |
| POST | `/v1/runs/:id/stop` | Wallet | session | – | `RunView` | agents |
| POST | `/v1/evidence-links` | Wallet | session | `CreateEvidenceLinkRequest` | `EvidenceLinkView` | evidence |
| GET | `/v1/evidence/:file` | anyone with the link | capability token | – | `<token>.json` → `EvidencePack`, `<token>.pdf` → PDF | evidence |
| GET | `/v1/receipts/:purchaseId` | Wallet | session | – | `ReceiptView` | evidence |
| GET | `/v1/disputes` | Wallet/Console | session | – | `ListDisputesResponse` | evidence |
| GET | `/v1/disputes/:id` | Wallet/Console | session | – | `DisputeDetailResponse` | evidence |
| POST | `/v1/disputes/:id/actions` | Console | session | `DisputeActionRequest` | `DisputeView` | evidence |
| POST | `/v1/demo/disputes/:purchaseId/simulate` | Console/Judge | session | `SimulateDisputeRequest` | `DisputeView` | evidence |
| GET | `/api/console/datasets/:name` | Console | session | – | `ConsoleDatasetResponse` | console |
| POST | `/api/console/query` | Console | session | `ConsoleQueryRequest` | `ConsoleQueryResponse` | console |
| POST | `/api/ai/studio` | Console (AG Studio adapter) | session | OpenAI Responses request | proxied provider response | console |
| POST | `/v1/demo/session` | Wallet (judge) | none (per-IP rate limit) | – | `DemoSessionResponse` + cookie | judge |
| GET | `/v1/demo/status` | Wallet | none | – | `DemoStatusResponse` | judge |
| POST | `/v1/demo/hero-run` | Wallet (judge) | judge session | – | `RunView` (202; 429 over the hourly limit) | judge |

Spike routes (`ENABLE_SPIKES=true` only): `/spikes/passkey/*`, `/spikes/webhooks/recent`.

## 5. Purchase saga transition table

Only the saga (money) writes `purchases.state`, only along `PURCHASE_TRANSITIONS` (`packages/core/src/purchase.ts`), each in one `uow.run` with its ledger event(s) and outbox row(s). PayPal calls happen in job handlers after COMMIT with `PayPal-Request-Id = <purchase_id>:<step>`. Every transition emits `purchase.updated` (and `budget.updated` when the budget changes).

| From | To | Trigger (caller) | Ledger event(s) in the same transaction | Outbox | PayPal call after commit (job) |
|---|---|---|---|---|---|
| – | PROPOSED | `saga.open` (api pipeline, checkout) | – (`CART_PROPOSED` was written at cart propose by api) | – | – |
| PROPOSED | BLOCKED | `saga.block` (schema/Writ/policy BLOCK) | `POLICY_DECIDED` (H_p, when a decision exists) + `PURCHASE_BLOCKED` | – | none: "$0 moved" |
| PROPOSED | BLOCKED | reserve updated 0 rows (limit or order slots) | `POLICY_DECIDED` + `PURCHASE_BLOCKED` (`budget_exhausted`) | – | none |
| PROPOSED | RESERVED | `saga.reserveAndAuthorize` (policy APPROVE/REVIEW) | `POLICY_DECIDED` + `BUDGET_RESERVED` | – | – |
| RESERVED | AUTHORIZING | same call (C_pre = sha256(H_w ‖ H_c ‖ H_p) stored) | – | `purchase.authorize` | – |
| RESERVED | FAILED | PayPal unconfigured / no ACTIVE vault token | `PURCHASE_FAILED` (`paypal_unconfigured` / `paypal_not_connected`) + `BUDGET_RELEASED` | – | none |
| AUTHORIZING | AUTHORIZED | `purchase.authorize` succeeded | `PAYPAL_ORDER_CREATED` (order_id, custom_id, c_pre, debug_id) + `PAYPAL_AUTHORIZED` | – | `POST /v2/checkout/orders` AUTHORIZE with `vault_id`, `custom_id = writ:<short>:<C_pre 40 hex>` (`<pur>:authorize`; `<pur>:order-authorize` if needed) |
| AUTHORIZING | FAILED | PayPal error (non-retryable), payer action required, declined | `PURCHASE_FAILED` + `BUDGET_RELEASED` (+ `PAYPAL_ORDER_CREATED` if an order exists) | `purchase.void` if an authorization exists | – |
| AUTHORIZED | VERIFYING | `saga.beginVerification` (pipeline) | – | – | – |
| AUTHORIZED | VOIDING | `saga.requestVoids` (kill switch, revoke, expiry) or the Writ is no longer ACTIVE | `BUDGET_RELEASED` (the caller appends `KILL_SWITCH`/`WRIT_REVOKED`/`WRIT_EXPIRED`) | `purchase.void` | – |
| VERIFYING | CAPTURING | `saga.execute`, final APPROVE, Writ still ACTIVE, settle ok | `VERIFIER_DECIDED` (H_verifier) + `BUDGET_SETTLED` | `purchase.capture` | – |
| VERIFYING | AWAITING_HUMAN | `saga.execute`, final REVIEW | `VERIFIER_DECIDED` + `HUMAN_REVIEW_REQUESTED` (approval row, 24 h) | `approval.expire` (available_at = expires_at) | – |
| VERIFYING | VOIDING | final BLOCK, settle refused, `requestVoids`, recovery (`verification_interrupted`) | `VERIFIER_DECIDED` (when a record exists) + `BUDGET_RELEASED` | `purchase.void` | – |
| AWAITING_HUMAN | CAPTURING | approval decided APPROVE with a verified passkey/device signature, settle ok | `HUMAN_APPROVED` (H_approval) + `BUDGET_SETTLED` | `purchase.capture` | – |
| AWAITING_HUMAN | VOIDING | DECLINE, `approval.expire` after 24 h, `requestVoids`, settle refused | `HUMAN_DECLINED` / `HUMAN_REVIEW_EXPIRED` + `BUDGET_RELEASED` | `purchase.void` | – |
| CAPTURING | CAPTURED | `purchase.capture` succeeded | `PAYPAL_CAPTURED` (capture_id, amount, c_post, invoice_id, debug_id) | – | `POST /v2/payments/authorizations/{id}/capture`, amount = `amount_minor` exactly, `final_capture: true`, `invoice_id = wv-<C_post 40 hex>` (`<pur>:capture`) |
| CAPTURING | VOIDING | PayPal permanently refused the capture | `PAYPAL_CAPTURE_FAILED` (+ `reverseSettlement`) | `purchase.void` | – |
| VOIDING | VOIDED | `purchase.void` succeeded | `PAYPAL_VOIDED` (c_post or null) | – | `POST /v2/payments/authorizations/{id}/void` (`<pur>:void`) |
| CAPTURED | REFUNDED | `purchase.refund` succeeded (platform liability) | `REFUNDED` | (`purchase.refund` was enqueued by the refund decision) | `POST /v2/payments/captures/{id}/refund` (`<pur>:refund`) |
| CAPTURED | DISPUTED | `saga.markDisputed` (evidence, `dispute.sync`) | `DISPUTE_OPENED` | – | – (the dispute was re-fetched before) |
| DISPUTED | DISPUTE_WON / DISPUTE_LOST | `saga.resolveDispute` (evidence, RESOLVED after re-fetch) | `DISPUTE_RESOLVED` | – | – |

C_post = sha256(C_pre ‖ H_verifier ‖ H_approval) with H_approval = 32 zero bytes when no human review happened; computed for a void after the verifier ran as well (plan §6.7). Recovery (money, every 30 s): AUTHORIZING/CAPTURING/VOIDING older than the step timeout re-run their step with the same PayPal-Request-Id (PayPal replays, never repeats); a VERIFYING purchase whose process died fails closed to VOIDING (`verification_interrupted`).

Saga guarantees (implemented in `src/saga`, `src/approvals`, `src/webhooks`): PROPOSED → RESERVED → AUTHORIZING (or FAILED/BLOCKED) commit in one transaction; `execute` re-parses the `VerificationRecord`, requires it to match the purchase and the stored combiner row, and takes the strictest verdict of `final` and its contributions, else it fails closed to BLOCK; `beginVerification` and `execute` throw `PurchaseStateChangedError` (409 `state_changed`) when the purchase already moved; recovery fails PROPOSED/RESERVED/AUTHORIZED/VERIFYING closed after `STALLED_PIPELINE_MS` and keeps one live job per in-flight money step; a device key can decide an approval only when the user has no passkey.

Ledger appends by owner: **api** `WRIT_SIGNED`, `WRIT_REVOKED`, `WRIT_EXPIRED`, `KILL_SWITCH`, `CART_PROPOSED`, `SENTINEL_SCANNED`; **money** everything in the table above; **evidence** `DISPUTE_UPDATED`, `DISPUTE_ANALYZED`, `DISPUTE_EVIDENCE_SUBMITTED`, `DISPUTE_CLAIM_ACCEPTED`. `TRACKING_ADDED` is P1-4.

Decisions rows (`decisions.stage`): api writes `preview` (cart propose), `schema`, `policy` (output = PolicyDecision, output_hash = H_p), `threshold`, `reserve`, `authorize`, `sentinel`, `verifier`, `combiner` (output = VerificationRecord, output_hash = H_verifier); money writes `human`.

## 6. Outbox topics, job handlers, periodic tasks

| Topic | Payload | Enqueued by | Handler (owner) | Handler does |
|---|---|---|---|---|
| `purchase.authorize` | `{ purchase_id }` | saga (money) | money | AUTHORIZE order on the ACTIVE vault token; → AUTHORIZED or FAILED |
| `purchase.capture` | `{ purchase_id }` | saga, approvals (money) | money | capture exact amount, `final_capture`, `invoice_id`; → CAPTURED |
| `purchase.void` | `{ purchase_id, reason }` | saga (money; via `requestVoids` for api) | money | void the authorization; → VOIDED |
| `purchase.refund` | `{ purchase_id, reason }` | money (platform-liability refund) | money | refund the capture; → REFUNDED |
| `approval.expire` | `{ approval_id }` | saga on AWAITING_HUMAN (money) | money | still PENDING at expires_at → EXPIRED → VOIDING |
| `paypal.webhook` | `{ event_id }` | webhook route after verify + `webhook_events` insert (money) | money | re-fetch the resource from PayPal (rule 15), reconcile; `CUSTOMER.DISPUTE.*` → enqueue `dispute.sync` |
| `dispute.sync` | `{ paypal_dispute_id, event_id }` | money (webhook), evidence (manual sync, simulate) | evidence | GET dispute; upsert `disputes`; `saga.markDisputed` / `resolveDispute`; analyst; auto-execute only when `canAutoExecute`, else `needs_human` |
| `dispute.execute` | `{ dispute_id, action, requested_by }` | evidence (auto or the console click) | evidence | provide-evidence (multipart JSON + PDF) / accept-claim / escalate; `DISPUTE_*` ledger events |

Periodic tasks: `saga.recovery` (money, 30 s), `approvals.timeout` backstop (money, 60 s), `writs.expiry` (api, 60 s: ACTIVE past `expires_at` → EXPIRED + `WRIT_EXPIRED` + `requestVoids(writ_expired)`), optional `auth.challenges.cleanup` (api). The runner (money) claims due rows (`published_at IS NULL AND dead_at IS NULL AND available_at <= now() AND (locked_until IS NULL OR locked_until < now())`) with `FOR UPDATE SKIP LOCKED`, sets `locked_until` and `attempts`, runs the handler outside the claim transaction, then marks `published_at`, backs off (`available_at`), or sets `dead_at`. It works the same on Postgres and PGlite. Handlers are idempotent.

## 7. SSE: `GET /v1/stream`

Tenant-scoped, session auth, frames `id: <id>` + `data: <StreamMessage JSON>` (no `event:` names), `: ping` every 15 s, `Cache-Control: no-cache, no-transform` (writer: `src/http/sse.ts openSse`; bus: `services.events`). `Last-Event-ID` replays from the in-memory buffer (`events.since`); `null` means refetch with the GET endpoints. Events are published after COMMIT (`TxContext.emit`), except run timeline rows, which the runner also persists before emitting.

| `event.type` | `event.data` | Producer |
|---|---|---|
| `purchase.updated` | `PurchaseView` | money (every saga transition) |
| `decision.recorded` | `DecisionView` | api (pipeline), money (`human`) |
| `attack.detected` | `AttackView` | api (pipeline, sentinel) |
| `approval.updated` | `ApprovalView` | money |
| `writ.updated` | `WritView` | api |
| `budget.updated` | `BudgetView` | money (reserve/settle/release), api (budget created at signing) |
| `ledger.appended` | `LedgerEventView` | automatic for every `appendLedger` |
| `run.updated` | `RunView` | agents |
| `run.event` | `RunEventView` | agents |
| `dispute.updated` | `DisputeView` | evidence |
| `paypal.updated` | `VaultStatusView` | web-flows |
| `kill_switch.engaged` | `KillSwitchResponse` | api |

Views that more than one stream emits or serves are built by the shared, frozen mappers in `src/http/views.ts`, so an SSE payload and a GET answer agree field for field: `purchaseView(row)`, `budgetView(row)`, `decisionView(row)`, `attackView(row)` (each parses its strict `@writ/core/api` schema; money leaves as decimal strings), plus `ledgerEventView` in `src/tx/ledger.ts`. Single-owner views (`WritView`, `ApprovalView`, `RunView`, `DisputeView`, `VaultStatusView`) are built in the owning stream's own files.

## 8. Auth, tenants, keys

- **Sessions** (`src/auth/session.ts`): cookie `writ_session` = base64url(JSON `{v:1, uid, tid, k, iat, exp}`) + `.` + base64url(HMAC-SHA256). HttpOnly, SameSite=Lax, Path=/, Secure when `APP_BASE_URL` is https; TTL 7 days (wallet) / 24 h (judge). `SESSION_SECRET` (≥ 32 chars) is required in production; development generates an ephemeral key and logs a warning. Issue with `services.sessions.issue(reply, { userId, tenantId, kind })`; read with `sessionOf(request)` / `judgeSessionOf(request)` (`src/auth/guards.ts`). CSRF: an unsafe request whose `Origin` is not `APP_BASE_URL` is treated as anonymous.
- **Tenants**: `tn_<ULID>` (`ids("tenant")`) minted at wallet registration and per judge visitor; no tenants table. Every query filters on the tenant from the session or the agent key, never on a value from the request. `SYSTEM_TENANT = "system"` (`src/db/enums.ts`) for webhook rows before resolution and global counters.
- **Agent keys** (`src/auth/agent-keys.ts`): `wak_` + 43 base64url chars; only `sha256(key)` in `agents.api_key_hash`; `Authorization: Bearer`; `await agentOf(request)` → `AgentPrincipal { agentId, tenantId, userId, kind, builtinKind }`. Every wallet gets one built-in Atlas and one built-in Scout at registration (api).
- **WebAuthn** (plan decision 2): ceremonies run in the Wallet on `APP_BASE_URL`; the gateway verifies with `config.webauthn = { rpId, rpName, origin }` (null → 503 `webauthn_unconfigured`). Registration/sign-in challenges: `auth_challenges` (32 random bytes, single use, short TTL). Writ signing challenge = H_w (single use: DRAFT → ACTIVE). Approval challenge = `approvalHash(approvalBody(request, decision))` (single use: PENDING → decided). Verify with `@writ/core/signatures` (`verifyWritSignature`, `verifyWebAuthnOverHash`, `requireUserVerification: true`), persist the new counter. Device keys (Ed25519, S6 fallback, judge demo key labeled) via `verifyDeviceEd25519`.
- **Capability links** (`evidence_links`): 32 random bytes, base64url in the URL, sha256 stored; optional expiry; per-IP rate limit through `@fastify/rate-limit` route config.
- **Webhooks**: PayPal postback verification (existing), then `webhook_events` insert-by-event-id dedupe and `paypal.webhook` job (money replaces the spike's in-memory dedupe on the production path). `src/app.ts` (frozen) imports `webhookRoutes`, `paypalWebhookVerifier`, `InMemoryWebhookDedupe` and the types `WebhookVerifier`, `WebhookDedupe` from `src/routes/webhooks.ts` and registers the plugin with `{ verifier, dedupe, exposeRecent }`; the money stream keeps those exports and that options shape, does the durable insert-dedupe through `app.services.db` inside the plugin when a database is present, and keeps the in-memory dedupe for database-less unit tests.

## 9. AI roles: wiring and degradation

`services.ai = createAiRuntime({ env: config.secrets.aiEnv(), now: clock, beforeModelCall: () => limits.tryConsumeLlmCall() })`. Model ids come only from `MODEL_<ROLE>` (rule 19).

| Role | Used by | Without its MODEL_* (or key) |
|---|---|---|
| Compiler | api `POST /v1/writs/compile` | 503 `ai_unavailable`; the Wallet opens the manual permission-card editor |
| Sentinel | api pipeline stage 6 (one scan per tainted source; page sources fetched through `services.pages`) | rules still run (spans, `attacks` rows); signal `{status:"error"}` → combiner REVIEW |
| Verifier | api pipeline stage 7 (typed cart + ProductFacts + datamarked titles + sentinel booleans) | `{status:"error"}` → REVIEW (fail closed) |
| Reader | agents (Scout) | Scout runs fail with `ai_unavailable` |
| Analyst | evidence (dispute engine) | `ANALYST_UNAVAILABLE` → ESCALATE_TO_HUMAN (`needs_human`) |
| Agent models | agents runner (Atlas, Scout planner) | the run is created and fails at once with `ai_unavailable` |
| Console (`MODEL_CONSOLE`) | console `POST /api/ai/studio` proxy: `resolveRoleModels("console", config.secrets.aiEnv())` from `@writ/ai`, `limits.tryConsumeLlmCall()` before every proxied call; keys never reach the browser | 503 `ai_unavailable`; the Trust & Safety dashboard and custom widgets still render without the chat harness (plan §17 S4 ladder) |

A role call that throws (stubs throw `NotImplementedError`) is treated exactly like a failure: fail closed. Over the daily LLM budget, roles answer `budget_exceeded` and the same rules apply.

## 10. Local run and environment

`pnpm install`, then `pnpm dev` (judge-owned `scripts/dev.ts`): the gateway on `http://localhost:10000` with `DATABASE_URL=pglite:<repo>/.data/gateway` (migrations at startup) and the Wallet on `http://localhost:3000` rewriting `/gw/*` to the gateway. `pnpm smoke:local` checks health, `/v1/meta`, the Wallet and the rewrite. No PayPal, model provider or Channel3 is needed; each degrades visibly (§9, `GET /v1/meta`). `.env` at the repo root is loaded by the launcher when present.

| Variable | Default | Production | Read by |
|---|---|---|---|
| `PAYPAL_ENV` | – (required) | `sandbox` | gateway, scripts |
| `APP_ENV` | development (`RENDER=true` → production) | production | gateway |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` / `PAYPAL_WEBHOOK_ID` / `PAYPAL_SANDBOX_BUYER_EMAIL` | unset → unconfigured | set | gateway |
| `APP_BASE_URL` | `http://localhost:3000` | Wallet origin (unset → passkeys 503) | gateway |
| `GATEWAY_BASE_URL` | `http://localhost:$PORT` (prod: `RENDER_EXTERNAL_URL`) | gateway origin | gateway, web (`/gw` rewrite, build time) |
| `GATEWAY_INTERNAL_URL` | `http://127.0.0.1:$PORT` | – | gateway (built-in agents) |
| `DATABASE_URL` | `pglite:.data/gateway` | `postgres://…` (required) | gateway |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` | Wallet host / `Writ` | Wallet host | gateway |
| `SESSION_SECRET` | ephemeral (warning) | required, ≥ 32 chars | gateway |
| `JUDGE_MODE` / `DEMO_HERO_RUNS_PER_HOUR` / `DEMO_LLM_CALLS_PER_DAY` / `DEMO_PAYPAL_VAULT_ID` | false / 5 / 1000 / unset | true / 5 / 1000 / S1 vault id | gateway |
| `CHANNEL3_API_KEY` | unset → search `unavailable` (fixture products only, labeled) | set | gateway |
| `MODEL_<ROLE>`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` | unset → role unavailable | set | gateway (`config.secrets.aiEnv()`) |
| `JOBS_ENABLED` / `JOB_POLL_INTERVAL_MS` | true / 1000 | true | gateway |
| `NEXT_PUBLIC_AG_STUDIO_LICENSE_KEY` | unset → watermark | set | web (console) |
| `PORT` / `HOST` / `LOG_LEVEL` / `ENABLE_SPIKES` | 10000 / 0.0.0.0 / info / false | Render | gateway |
| `TEST_DATABASE_URL` | unset → real-Postgres tests skipped | – | tests |

## 11. Dependencies added (Nov 1, one pass)

| Package | Version | Workspace | Why |
|---|---|---|---|
| `@electric-sql/pglite` | ^0.5.0 (moved dev → prod) | gateway | file-backed Postgres for local runs (decision 4); loaded lazily, never in a postgres deployment |
| `@fastify/cookie` | ^11.1.5 | gateway | session cookie parse/serialize (HMAC done in `auth/session.ts`) |
| `@fastify/rate-limit` | ^11.2.1 | gateway | per-IP limits on unauthenticated judge and capability-link endpoints (opt-in per route) |
| `pdf-lib` | ^1.17.1 | gateway | the 2-page evidence PDF (plan §8.6, §14); no headless browser on Render |
| `@writ/ai`, `@writ/agents` | workspace | gateway | AI runtime; built-in agent runs |
| `htmlparser2`, `domhandler`, `domutils`, `css-select` | ^12 / ^6 / ^4 / ^7 | ai | Sentinel HTML pre-processing (visible vs hidden text, CSS-hidden via `<style>` selectors) and the Reader's page text |
| `htmlparser2`, `domhandler`, `ai`, `zod` | as above / ^7 / ^4 | agents | page text for the read_page tool; AI SDK tool loops; contracts |
| `next`, `react`, `react-dom` | ^16.4.3 / ^19.3.1 | web | Next.js App Router (plan §14) |
| `tailwindcss`, `@tailwindcss/postcss` | ^4.3.3 | web | Tailwind v4 (plan §14) |
| `motion` | ^14.9.0 | web | Framer Motion (renamed `motion`): seal stamp, "two keys turn", strike-through (plan §10) |
| `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react` | ^1.8 / ^0.7 / ^2.1 / ^3.7 / ^1.66 | web | the shadcn/ui building blocks (plan §14 "shadcn/ui re-themed"): accessible primitives, variants, class merging, icons |
| `@fontsource-variable/fraunces`, `/inter`, `/jetbrains-mono` | ^5.3.0 | web | the one serif, one sans, one mono (plan §10), self-hosted so builds need no font network |
| `@simplewebauthn/browser` | ^14.0.0 | web | passkey ceremonies in the Wallet (plan §14), pairs with the server's v14 |
| `@paypal/paypal-js` | ^11.3.0 | web | official JS SDK v6 loader + types (`@paypal/paypal-js/sdk-v6`) for "Connect PayPal" (plan §7 row 2) |
| `ag-studio`, `ag-studio-react` | 3.0.0 (exact) | web | the AG Studio console (plan §11); same versions as `paypaldev/hackathon-paypal-ag-grid-boilerplate` |
| `ag-grid-community`, `ag-grid-react`, `ag-grid-enterprise`, `ag-charts-react`, `ag-charts-enterprise` | 36.2.0 / 14.2.0 (exact) | web | AG Studio's grid/charts peers, and the plan §17 S4 last-resort fallback (AG Grid Enterprise + AG Charts) |
| `@types/react`, `@types/react-dom` | ^19.3.0 | web (dev) | types |
| `eslint-plugin-react-hooks`, `@next/eslint-plugin-next` | ^7.1.1 / ^16.4.3 | root (dev) | lint rules for `apps/web` |
| `@writ/*` workspace links | – | evals, scripts | WritBench runs the full gateway in sink mode; smoke script uses the agent client |

Not added: `pg-boss` (replaced by the outbox poller, decision 3), MCP SDK and Agent Toolkit (P1), Kernel (P2), a data-fetching library (web-foundation builds a small typed client on `fetch` + the SSE hook).

## 12. Database (migration `0002_p0_contracts`)

All changes are additive (new tables, nullable or defaulted columns, CHECKs on empty tables). New tables: `auth_challenges`, `agent_runs`, `agent_run_events`, `evidence_links`, `catalog_items`, `rate_counters`. New columns: `users.demo`; `passkeys.{aaguid, backed_up, last_used_at}`; `device_keys.{label, demo, revoked_at}`; `paypal_vault_tokens.{setup_token_id, payer_hint, demo, updated_at}` (`vault_id` nullable while PENDING; ACTIVE requires it); `agents.{builtin_kind, key_hint, last_used_at}`; `writs.{signed_at, revoked_at, revoke_reason, synthetic}`; `writ_budgets.held_orders` (CHECK `held_orders >= 0`, `orders_count + held_orders <= max_orders`); `purchases.{state_reason, state_detail, final_verdict, vault_token_id, synthetic}`; `decisions.{purchase_id, output, output_hash}` (+ stage CHECK); `approvals.{request, decision, body_hash}` (+ status CHECK, one approval per purchase); `disputes.{liability, confidence, needs_human, amount_minor, currency, paypal_snapshot, resolved_at, synthetic, updated_at}`; `webhook_events.{resource_type, resource_id, error}`; `attacks.{score, detector, purchase_id, writ_id, synthetic}`; `outbox.{dedupe_key, attempts, available_at, locked_until, last_error, dead_at}`. No stream changes the schema after this migration.

`held_orders` (adopted, plan §6.8): reserve guard `orders_count + held_orders < max_orders` and `held_orders + 1`; settle moves one held order to `orders_count` (and reserved → spent); release returns it. With `max_orders = 1` two concurrent checkouts yield exactly one reservation (property-tested).
