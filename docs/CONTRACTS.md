# Do It Once — Contracts (S1)

Every agent codes against this file and `lib/contracts.ts`. Only the session lead changes
either. If you need a contract change, say so in your final report instead of making it.

## Stack (installed by the lead — do NOT add or change dependencies)
Next.js 16 App Router (root of repo), React 19, TypeScript 5.9 strict, Tailwind v4
(`@import 'tailwindcss'` in `app/globals.css`), `@neondatabase/serverless` v1,
`@onkernel/sdk` 0.119 + `playwright-core`, `tsx` for scripts, `vitest` for tests,
`zod`, `dotenv`. Path alias `@/*` → repo root. ESM (`"type": "module"`).
If you truly need another package, stop and report it. Never edit `package.json`.

Scripts: `npm run dev`, `npm run typecheck`, `npm test`, `npm run db:migrate`, `npm run db:seed`.
Standalone scripts load env with `import 'dotenv/config'` (Next loads `.env` itself).

## Ownership (touch only your folders)

| Agent | Owns |
|---|---|
| F2 Schema | `db/`, `lib/neon/`, `scripts/migrate.ts`, `scripts/seed.ts` |
| B1 Demo site | `demo-site/` (self-contained, zero dependencies) |
| B2 Kernel | `lib/kernel/`, `scripts/smoke-kernel.ts` |
| B3 Engine | `lib/engine/` except `verify.ts` / `extract.ts` |
| B4 API | `app/api/` |
| B5 Dashboard | `app/page.tsx`, `app/(dashboard)/`, `app/globals.css`, `app/layout.tsx`, `components/` except `components/evidence/`, `lib/client/` |
| B6 Evidence | `lib/engine/verify.ts`, `lib/engine/extract.ts`, `lib/engine/*.verify.test.ts`, `components/evidence/` |

Stub files (`lib/neon/repo.ts`, `lib/kernel/index.ts`, `lib/engine/index.ts`,
`lib/engine/verify.ts`) already exist with fixed signatures. Replace the bodies; keep the exports.

## Server/client rule
Provider SDKs, `lib/neon`, `lib/kernel`, `lib/engine` and `lib/env.ts` are server-only.
Client components fetch `/api/*` only. Never put a secret in a `NEXT_PUBLIC_` var.

## The demo site (B1) — "Lumen+" (fictional streaming membership)

Zero-dependency Node `node:http` server in `demo-site/server.mjs`, server-rendered HTML + inline
CSS, port `process.env.PORT || 4000`. Must look like a real, polished consumer website.
Single demo account ("Ali Amjad", already signed in — no login). In-memory state.

Exact visible text matters: the seeded skill and verification depend on it.

| Path | Must show | Leads to |
|---|---|---|
| `/` | Marketing header with an **Account** link | `/account` |
| `/account` | "Welcome back, Ali"; sidebar links **Overview**, **Profile**, **Billing**, **Devices** | Billing → `/account/billing` |
| `/account/billing` | Payment method (Visa •••• 4242), invoices table, membership row "Lumen+ Premium · $19/month · Renews tomorrow (<date>)" (or "Renews: No" when canceled), button **Manage membership** | `/account/membership` |
| `/account/membership` | Plan card "Lumen+ Premium", "$19/month", "Next renewal: <date>", **Change plan** (no-op), less prominent link **Cancel membership**. When canceled: "Membership canceled", "Renews: No", "Access ends on <date>" | `/account/membership/cancel` |
| `/account/membership/cancel` | Retention page "Before you go…" offering 50% off for 3 months, buttons **Accept offer** (no-op notice) and **No thanks, continue to cancel** | `/account/membership/cancel/confirm` |
| `/account/membership/cancel/confirm` | "Confirm cancellation", "$19/month", "You'll keep access until <date>", a `<form method="post">` with button **Confirm cancellation** | POST → state canceled → 303 to `/account/membership?canceled=1` |
| `GET /api/state` | `{ status: "active" \| "canceled", renewsOn, endsOn, layout }` JSON | |
| `POST /api/reset` | Header `x-reset-token: $DEMO_RESET_TOKEN` (skip check if env unset) → back to active | |

`<date>` = tomorrow, formatted like "Nov 5, 2026". Keep page structure easy to change later:
S5 adds `?layout=v2` (Billing moves under "Plan & payments", renamed buttons).
Also provide `demo-site/Dockerfile` and `demo-site/fly.toml` (app `do-it-once-demo`,
`min_machines_running = 1`, `internal_port = 4000`).

Locally: `node demo-site/server.mjs`, then the lead exposes it with
`cloudflared tunnel --url http://localhost:4000` and sets `DEMO_SITE_URL`.

## The seeded skill (F2 seeds, B1 matches, B3 executes)

**Cancel subscription** — icon `subscription`, valuePerYear `228`,
startUrl `${DEMO_SITE_URL}/account`, targetDomains `[host of DEMO_SITE_URL]`,
runCount 3 / successCount 3 (prior history), confidence 1, version 1.
Triggers: "cancel subscription", "get rid of this subscription", "stop paying for this",
"cancel my membership", "unsubscribe from this service".
Preferences: `{ "confirm_before_cancel": true, "decline_retention_offers": true }`.

| # | intent | action | targetDescription | inputSource | matchText | expectedAfter | locatorHint | approval |
|---|---|---|---|---|---|---|---|---|
| 1 | Open my Lumen+ account | navigate | null | `url:/account` | | `Welcome back` | | |
| 2 | Open billing settings | click | Billing link in the account sidebar | | Billing | `Manage membership` | `role=link[name="Billing"]` | |
| 3 | Open membership management | click | Manage membership button | | Manage membership | `Cancel membership` | `role=link[name="Manage membership"]` | |
| 4 | Start cancellation | click | Cancel membership link | | Cancel membership | `Before you go` | `role=link[name="Cancel membership"]` | |
| 5 | Decline the retention offer | click | No thanks, continue to cancel button | | No thanks, continue to cancel | `Confirm cancellation` | `role=link[name="No thanks, continue to cancel"]` | |
| 6 | Confirm the cancellation | click | Confirm cancellation button | | Confirm cancellation | `Membership canceled` | `role=button[name="Confirm cancellation"]` | **yes**: "Cancel $19/month membership?" / "Agent reached the final cancellation screen. This is irreversible." |

Verification: `anyOf: [text_contains "Membership canceled", text_contains "Renews: No"]`,
`allOf: [url_matches "/account/membership(\?|$)"]` (regex; must not match /cancel).

Display-only skills (history only, no steps needed yet): **Return online order** (icon `return`,
7 runs / 6 success), **Book haircut** (`haircut`, 9/9), **Renew registration** (`registration`, 1/1).

Seeded Today trigger: source `seed`, subject "Your Lumen+ membership renews tomorrow",
payload `{ merchant: "Lumen+", amount: "$19/month", cadence: "monthly", dueLabel: "Renews tomorrow" }`,
matched to Cancel subscription, state `pending`.

## Database (F2)
Tables per the brief: `users`, `personal_skills`, `skill_triggers` (with `embedding vector(1024)`
nullable — filled in S3), `skill_steps`, `skill_preferences`, `skill_runs`, `execution_events`
(unique `(run_id, sequence)`), `approvals`, `artifacts` (+ `content_base64 text`),
`incoming_triggers`. UUID PKs via `gen_random_uuid()`, `timestamptz` everywhere, JSONB for
config/payload/result/metadata, sensible FK indexes. Do not touch existing tables (`hello`, `mastra_*`).
Migrations are plain SQL in `db/migrations/NNN_name.sql`, applied by `scripts/migrate.ts`
(tracked in `_migrations`). Seed is idempotent (fixed UUIDs, upserts) and `--reset` restores the
demo state (Cancel skill counts back to 3/3, trigger pending, demo runs deleted).

## API (B4) — all JSON, `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`

| Route | Returns |
|---|---|
| `GET /api/today` | `{ items: TodayItem[] }` |
| `GET /api/skills` | `{ skills: SkillSummary[] }` |
| `GET /api/skills/:id` | `{ skill: SkillDetail, runs: SkillRun[] }` |
| `POST /api/runs` `{ skillId, triggerId? }` | `{ runId }` (calls `getRunEngine().startRun`, userId = `DEMO_USER_ID`) |
| `GET /api/runs?limit=10` | `{ runs: SkillRun[] }` |
| `GET /api/runs/:id` | `RunView` |
| `GET /api/runs/:id/events?after=N` | SSE stream of `RunStreamFrame` (`data: <json>\n\n`); polls Neon every 500 ms; sends `done` and closes on a terminal state; heartbeat comment every 15 s |
| `POST /api/runs/:id/approve` | `{ ok: true }` (calls `engine.approve`) |
| `POST /api/runs/:id/stop` | `{ ok: true }` |
| `GET /api/artifacts/:id` | the bytes with the right `Content-Type` |
| `POST /api/demo/reset` | resets the demo site (`POST $DEMO_SITE_URL/api/reset`) and DB demo state (same as seed `--reset`) → `{ ok: true }` |

Errors: `{ error: string }` with 4xx/5xx.

## Run engine semantics (B3)
`createRunEngine({ repo, browser, verify, extract })` for tests; `getRunEngine()` wires the real ones.
- `startRun`: `createRun` (queued) → trigger `running` → return `{ runId }`; execute in background (in-process; guard with a Set of active run ids).
- Execute: state `running`, `run.started`; open browser if none (`browser.open({ startUrl })`, save `browserSessionId`/`liveViewUrl`, `browser.opened`); for each step from `currentStep`:
  - update `currentStep`;
  - if `requiresApproval` and no approved approval for this step: `readPage`, payload via `extractApprovalPayload(page)`, `createApproval`, state `waiting_approval`, `approval.requested`, **return** (browser stays open);
  - else `step.started` → perform (`navigate` resolves `url:` relative to the skill's startUrl origin) → check `expectedAfter` (any `|` alternative in page text, else `waitForText` 8 s) → `step.succeeded` (persist `usedLocator` via `updateStepLocator` if it differs) or `step.failed` → run `failed`.
- After the last step: state `verifying`, `verify.started`, `readPage` + `screenshot` → `createArtifact` (`artifact.saved`) → `verifyPage` → `succeeded` (`result`, `recordSkillOutcome(true)`, trigger `done`, `verify.passed`, `run.succeeded`) or `failed` (`verify.failed`, `recordSkillOutcome(false)`). Close the browser.
- `approve`: pending approval → `approved`, `approval.granted`, state `resumed`, continue in background from `currentStep`. If the browser session is gone (e.g. Kernel timeout or server restart), open a new one and fast-replay steps before the approval step, then continue.
- `stop`: deny pending approval, state `stopped`, `run.stopped`, close the browser, trigger back to `pending`.
- Every event message is human-readable — it is shown in the UI ("Opened billing settings").

## Browser adapter (B2)
Implements `BrowserAdapter` on Kernel: `kernel.browsers.create({ timeout_seconds: 1800, viewport 1280×800 })`,
Playwright `connectOverCDP(cdp_ws_url)`, connection cache per session id with reconnect via
`kernel.browsers.retrieve`. Element resolution order: `locatorHint` → role link/button with
name ≈ `matchText` → `getByText(matchText)` → words from `description`. Return the selector that
worked as `usedLocator`. `readPage` returns visible text (collapsed, ≤ 8k chars).

## Evidence (B6)
`verifyPage(spec, page)` pure + unit tests. `extractApprovalPayload(page): Approval['payload']`
(price like `$19/month`, renewal date, merchant from title). `components/evidence/ProofPanel.tsx`
(client component; props `{ result: RunResult }`) shows verdict, evidence snippets, final URL,
timestamp and screenshot from `/api/artifacts/:id`.

## Dashboard (B5)
Product UI, not a developer dashboard. See PLAN.md S1/B5. Talks only to the API above through
`lib/client/api.ts` + `useRunStream(runId)` (EventSource). Must also render from mock data with
`?mock=1` so it can be developed before the API exists.
