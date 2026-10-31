# Writ — rules for humans and AI coding agents

> Copied verbatim from `plan.md` §22. `plan.md` is the source of truth; read §0, §5 and §22 before touching code.

## 22. STRICT RULES — follow exactly (humans and AI coding agents)

Copy this section verbatim into `CLAUDE.md` and `AGENTS.md`. "MUST" and "NEVER" are literal.

**A. Time and process**
1. The deadline is Nov 12, 12:00 PM PST = **Nov 13, 01:30 IST**. Our deadline is **Nov 12, 18:00 IST**. Nothing is planned after it.
2. Gates are binary. If a gate is red, apply the §5 cut list **within the hour** — never "one more day".
3. P0 before P1 before P2. No P1 work until G2 is green (exception: P1-1 MCP once G2 is green early).
4. Feature freeze Tue Nov 10, 21:00 IST. After it: bug fixes, copy, video and docs only.
5. Every morning read Devpost Updates and Discord announcements (10 min). Every night fill and commit the §24 scorecard.
6. Blocked > 2 h on a PayPal or sponsor issue → post in the PayPal Discord with the `PayPal-Debug-Id` and a minimal repro, then switch to the documented fallback while waiting.
7. More than 3 h on one sandbox behavior → take the fallback and record it under README "Known limitations".

**B. Money path**
8. LLMs NEVER move money. Only `packages/paypal`, called by the saga, may authorize, capture, void or refund. No LLM tool has a payee, amount or address parameter.
9. A deterministic BLOCK is final. LLM verdicts can only raise severity (APPROVE → REVIEW → BLOCK), NEVER lower it.
10. Fail closed: any timeout, parse error or missing data in the decision pipeline → REVIEW (BLOCK if policy-related).
11. Capture exactly the verified total with `final_capture: true`. NEVER capture more; NEVER re-authorize silently.
12. Every PayPal POST MUST send `PayPal-Request-Id`; every agent checkout MUST carry `Idempotency-Key`.
13. Money is integer minor units end to end; formatting only at the UI edge.
14. Every state change is one DB transaction containing the state update + ledger event + outbox row. No side effect before commit.
15. Webhooks: verify the signature via the PayPal API, dedupe by event id, re-fetch the resource before acting.

**C. AI and security**
16. Untrusted text (web pages, product titles/descriptions, dispute messages, agent rationales) NEVER enters a privileged prompt raw: datamark it, cap its length, label it as data.
17. The Verifier NEVER sees raw pages or agent rationale.
18. Every LLM output MUST be Zod-validated; one repair retry; then fail closed.
19. Model IDs, keys and limits live in env vars. Verify current model IDs in provider consoles; never copy IDs from old tutorials.
20. Secrets NEVER in git. `.env.example` only. Secret scanning + push protection on. If a secret leaks: rotate first, then clean history.
21. Sandbox only. NEVER put live PayPal credentials in the repo, env or demo.
22. Attack fixtures live under `fixtures/` and the `/fixtures/` route, labeled "security test fixture", `noindex`.

**D. Honesty (judges and automated analysis will check)**
23. No mocks in the hero path. Every PayPal ID in the video and README is a real sandbox ID.
24. No invented numbers. Every metric comes from a committed script output in `evals/results`. Problem statistics in the video are verified against the primary source and cited in the description.
25. Label simulations on screen: "sandbox", "simulated fulfillment", "sandbox adjudication", "time-skip", "synthetic history".
26. Disclose AI use fully on Devpost: product models per role and the AI coding assistants used.

**E. Quality bar**
27. TypeScript strict; no `any` in `packages/core`, `packages/paypal`, `packages/ledger`; Zod at every boundary.
28. Tests required before merge for: policy engine (100% branch), hashing/signing, reservation property test, saga recovery, webhook verification, combiner monotonicity.
29. One design system (§10): one serif, one sans, one mono, one accent color, 8-pt spacing. No default-looking components. Mobile first for the Wallet.
30. Every screen has loading, empty and error states. Zero console errors on the hero path.

**F. Repo, deploy, judge access**
31. Public repo from day one with MIT `LICENSE` at the root (shows in About). Small, frequent Conventional Commits — the history is evidence of work done inside the window.
32. `main` is always deployable; Render auto-deploys `main`; a post-deploy smoke script runs the hero scenario in judge mode.
33. Paid Render instances (credits) for web, gateway and Postgres. NEVER free Postgres.
34. Request the AG Studio 45-day trial on or after Nov 1 IST; verify the app degrades to a watermark, not a crash, without a license.
35. Keep the hosted demo working, free and credential-ready until **Dec 15, 21:30 IST**. After submitting, freeze `main` at `v1.0-submission`; only availability fixes, each logged in `POST-SUBMISSION.md`.

**G. Video and submission**
36. Video under 2:55, public on YouTube, captions on, no copyrighted music, no third-party brand logos, real UI only, shown running on its devices (browser + phone).
37. Every Devpost field filled; opt into AG Grid, Channel3 and Render; testing instructions include the judge-mode link and the sandbox buyer login; complete submission by Nov 11, 23:59 IST; final edit by Nov 12, 18:00 IST; screenshot the "Submitted" state.

**H. For AI coding agents (Claude Code / Cursor / Codex) in this repo**
38. At session start read `plan.md` §0, §5 and §22. Work on one task ID at a time; put the ID in the first line of your reply and in the commit message.
39. NEVER change the architecture, schemas or money path without updating `plan.md` in the same commit and saying so explicitly.
40. NEVER add a dependency without stating why; prefer the §14 stack.
41. NEVER mock PayPal outside `evals/` and unit tests; NEVER weaken or delete a failing test to get green.
42. Run `pnpm lint && pnpm typecheck && pnpm test` before every commit and report the summary.
43. If PayPal, AG Studio or Channel3 behaves differently from this plan: stop, report the exact response (with `PayPal-Debug-Id`), propose the plan change. NEVER silently work around it.
44. Output complete files or exact diffs — no "rest unchanged" placeholders in code.
