# Do It Once — Build Plan (multi-session, multi-agent)

> Do it once. Your agent does it forever.

This is the master plan. Every session reads this file first, then `docs/CONTRACTS.md`
(created in Session 1), then the relevant `.claude/skills/<sponsor>/SKILL.md` files.

## How the work is split

**Sessions** are separate Claude Code conversations. Each has one **lead** (the main
session) that plans, integrates, and verifies. Sessions run one after another, or side by
side when their phases don't depend on each other.

**Sub-agents** are spawned by the lead for independent work. Each sub-agent:
- runs in its own git worktree (`isolation: "worktree"`) so agents never edit the same checkout
- **owns specific folders** (listed per agent below) and touches nothing else
- codes against `docs/CONTRACTS.md`, mocking anything another agent is still building
- finishes with: typecheck passes, a smoke test for its piece, a short report

**Lead responsibilities in every session:** spawn agents, merge their worktrees, resolve
integration issues, run the phase gate, commit, and append a handoff note to `docs/HANDOFF.md`.

### Why ~6 agents per session and not 100
Agent count is capped by how many **independent, non-overlapping** pieces of work exist.
Past that, agents collide on shared files and the lead spends more time merging than
building. This plan uses as many agents as the work can genuinely split into:
**8 sessions, ~40 sub-agents total, max 4 sessions running side by side.**

## Session map

```
S1  Foundation + Phase 1 vertical slice   ──►  S2  Phase 2 Mastra + Assistant UI
                                                    │
                                     ┌──────────────┴──────────────┐
                                     ▼                             ▼
                          S3  Phase 3 Skill memory      S4  Phase 4 AgentMail
                                     │                             │
                                     ▼                             │
                          S5  Phase 5 Self-heal (Exa)              │
                                     │                             │
                     ┌───────────────┼─────────────────────────────┘
                     ▼               ▼
          S6  Phase 6a Sprites +   S7  Phase 6b Teach Mode
              Executor + Return        (Chrome extension)
                     │               │
                     └───────┬───────┘
                             ▼
                  S8  Phase 7 Ship: README, deploy, demo rehearsal
```

| Session | Phase | Sub-agents | Can run alongside | Depends on |
|---|---|---|---|---|
| S1 | 0 + 1: Foundation + vertical slice | 2 (foundation) then 6 (build) + 1 verifier = **9** | — | — |
| S2 | 2: Mastra + Assistant UI | 3 + 1 verifier = **4** | — | S1 |
| S3 | 3: Skill memory + semantic retrieval | 4 + 1 verifier = **5** | S4 | S2 |
| S4 | 4: AgentMail triggers | 3 + 1 verifier = **4** | S3 | S2 |
| S5 | 5: Self-heal with Exa | 3 + 1 verifier = **4** | — | S3 |
| S6 | 6a: Sprites + Executor + Return skill | 4 + 1 verifier = **5** | S7 | S5 (S4 for the Return email) |
| S7 | 6b: Teach Mode | 3 + 1 verifier = **4** | S6 | S3 |
| S8 | 7: Ship | 4 = **4** | — | all |
| | | **~39** | | |

---

## Repository layout (set in S1, owned per agent)

```
/                         Next.js 15 App Router app (the product)
  app/                    pages + route handlers
    (dashboard)/          home, skill library, run view
    api/                  runs, approvals, events (SSE), webhooks, teach
  components/             UI components
  lib/
    contracts.ts          shared types (the single source of truth)
    neon/                 db client, repositories, migrations runner
    kernel/               browser adapter
    exa/                  research adapter
    agentmail/            inbox adapter
    executor/             MCP/API adapter
    fly/                  Sprite adapter
    engine/               run engine (P1) → wraps Mastra workflow (P2)
    mastra/               Mastra instance, workflows, agents, tools
  db/migrations/          plain SQL, numbered
  scripts/                seed, smoke tests, demo helpers
demo-site/                separate small Next.js app: "StreamFlix"-style membership site
                          + store with orders/returns; deployed as its own Fly app
extension/                Chrome extension for Teach Mode (S7)
legacy/                   existing prototype files (agent.mjs, server.mjs, ...)
docs/                     PLAN.md, CONTRACTS.md, HANDOFF.md, DEMO_SCRIPT.md
```

---

## S1 — Foundation + Phase 1 vertical slice

**Goal:** cancel the demo subscription end to end through Kernel, with an approval stop,
verification, everything saved in Neon, and a polished dashboard.

### Step A — Foundation (lead + 2 agents, must finish before Step B)

The lead writes `docs/CONTRACTS.md` + `lib/contracts.ts` itself, because every later
agent depends on them:
- types: `Skill`, `SkillStep` (intent, expected_before, action_type, target_description,
  input_source, expected_after, locator_hint), `SkillRun`, `RunState`
  (`queued|running|waiting_approval|resumed|verifying|succeeded|failed|stopped`),
  `ExecutionEvent`, `Approval`, `Artifact`, `IncomingTrigger`
- adapter interfaces: `BrowserAdapter` (open, click, type, extract, screenshot, liveViewUrl,
  close), `ResearchAdapter`, `InboxAdapter`, `ToolAdapter`, `WorkspaceAdapter`
- API routes and their payloads, SSE event format

| Agent | Owns | Task |
|---|---|---|
| F1 Scaffold | `/` root config, `app/layout.tsx`, `legacy/` | Move prototypes into `legacy/`; scaffold Next.js 15 + Tailwind v4 + TypeScript; `.env.example` documenting every var; base design tokens/fonts |
| F2 Schema | `db/`, `lib/neon/` | Migration `001_init.sql` (all tables from the brief + pgvector + indexes), migration runner, typed repositories, seed script with the user + Cancel Subscription skill (+ 3 display-only skills for the library) |

### Step B — Build (6 agents in parallel)

| Agent | Owns | Task | Done when |
|---|---|---|---|
| B1 Demo site | `demo-site/` | Realistic membership site: login (pre-seeded), Account → Billing → Manage Membership → Cancel → Confirm → "Membership canceled, ends Nov 4". Server-side state with a reset endpoint. Deploy to Fly as its own app (`min_machines_running = 1`) | Public URL works; reset works |
| B2 Kernel adapter | `lib/kernel/` | `BrowserAdapter` on `@onkernel/sdk` + `playwright-core` over CDP; semantic actions (find element by visible text/role from `target_description`, with `locator_hint` first); screenshots; live view URL; cleanup | Smoke script cancels on the deployed demo site |
| B3 Run engine | `lib/engine/` | Plain TS step runner (no Mastra yet): executes `SkillStep`s through `BrowserAdapter`, writes `execution_events`, pauses at steps flagged `requires_approval`, resumes, runs explicit verification (text/URL evidence + screenshot), stores the result | Unit tests against a mock browser |
| B4 API | `app/api/` | `POST /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/events` (SSE), `POST /api/runs/:id/approve`, `/stop` | Curl script drives a run with a mock engine |
| B5 Dashboard UI | `app/(dashboard)/`, `components/` | "DO IT ONCE" home: Today card (renewal, $19/mo), Run button, Agent Activity checklist, embedded Kernel live view, approval card, huge success state ("✓ CANCELED — $228/year no longer recurring"), My Skills grid. Built against mocked API | Looks finished on desktop + mobile width |
| B6 Evidence | `lib/engine/verify*`, `components/evidence/` | Verification rules per skill (text contains, URL matches), screenshot storage (Neon `artifacts` + bytes for now), proof panel UI | Proof panel shows text, URL, screenshot, timestamp |

### Step C — Integrate + verify (lead + 1 verifier agent)
Lead merges B1–B6 and wires real adapters. **V1 verifier** runs the full flow in the
browser pane 3 times in a row and reports any failure.

**Gate S1:** Run → live browser visibly clicks through → stops at "Cancel $19/month
membership?" → Approve → verified canceled → success screen → run + events + evidence in
Neon. Survives a page refresh while waiting for approval.

---

## S2 — Phase 2: Mastra + Assistant UI

**Goal:** orchestration becomes a real Mastra workflow with suspend/resume persisted in Neon;
the chat is Assistant UI.

| Agent | Owns | Task |
|---|---|---|
| M1 Workflow | `lib/mastra/` | `choreRun` workflow: understand intent → retrieve skill → prepare → execute steps → `suspend()` at the approval step → resume → verify → complete. `PostgresStore` on Neon. Streams `writer.write()` events that map onto `ExecutionEvent` |
| M2 Engine swap + routes | `lib/engine/`, `app/api/runs/` | Engine delegates to Mastra; approve/stop call `run.resume()`; list suspended runs on load; resume after a server restart |
| M3 Assistant UI | `app/(dashboard)/chat/`, `components/assistant-ui/` | `useChatRuntime` + `Thread`; Mastra agent route via `@mastra/ai-sdk`; toolkit renderers for run progress, live view, Approve/Stop card; Assistant Cloud thread persistence |
| V2 Verifier | — | Kill the server mid-approval, restart, approve, confirm it completes |

**Gate S2:** "Get rid of this subscription" typed in chat → workflow runs → suspends →
server restart → approve → verified done.

---

## S3 — Phase 3: Skill memory + semantic retrieval (side by side with S4)

| Agent | Owns | Task |
|---|---|---|
| K1 Recorder | `lib/engine/recorder*` | Record every action the agent performs (URL, action, target, input, page evidence, result) into an action trace |
| K2 Normalizer + versioning | `lib/skills/` | LLM turns a successful trace into intent-based `skill_steps`; skills get versions; replay uses steps as hints, falls back to the agent reasoning from the live page |
| K3 Retrieval | `lib/skills/retrieve*`, `db/migrations/002*` | Embeddings for trigger phrases (Neon AI Gateway, else Mastra/OpenAI); pgvector search; "return my headphones" → Return, "stop paying for this" → Cancel |
| K4 Skill UI | `app/(dashboard)/skills/` | Skill library + detail page: steps, preferences, run history, success rate, version, confidence |
| V3 Verifier | — | Retrieval test set of ~20 phrases; replay from stored steps |

**Gate S3:** a run creates/updates a skill; replay uses stored steps; semantic retrieval
picks the right skill for paraphrases.

## S4 — Phase 4: AgentMail triggers (side by side with S3)

| Agent | Owns | Task |
|---|---|---|
| E1 Inbox | `lib/agentmail/`, `scripts/agentmail-*` | Create agent + demo-sender inboxes, register webhook, WebSocket fallback listener |
| E2 Webhook + classifier | `app/api/webhooks/agentmail/`, `lib/triggers/` | Svix-verified route; classify the email (price, renewal date, merchant); dedupe; write `incoming_triggers`; match skill |
| E3 Today UI | `components/today/` | "Membership renewal detected · $19/month · Matching skill: Cancel Subscription · [Run]" card, live updates |
| V4 Verifier | — | Send the demo email → card appears in under 10 seconds → Run works |

**Gate S4:** demo email in → pending task on the home screen → Run → existing flow.

---

## S5 — Phase 5: Self-heal

| Agent | Owns | Task |
|---|---|---|
| H1 Demo site v2 | `demo-site/` | Layout switch (`?layout=v2` / admin toggle): Billing moves under "Plan & Payments", button text and structure change |
| H2 Heal loop | `lib/heal/` | Detect step failure → Exa research for the current procedure → agent explores the live page through Kernel → completes → writes skill version N+1 with the new path |
| H3 Heal UI | `components/heal/` | "Website changed — healing" timeline, Exa sources, old vs new step diff, version bump |
| V5 Verifier | — | Flip to v2, run, confirm heal + new version; run again, confirm it uses the healed path with no Exa call |

**Gate S5:** a changed site breaks the stored path, the agent heals it, and the skill updates.

---

## S6 — Phase 6a: Sprites + Executor + Return skill (side by side with S7)

| Agent | Owns | Task |
|---|---|---|
| X1 Sprite workspace | `lib/fly/` | `WorkspaceAdapter` on `@fly/sprites`; `/home/sprite/workspace/{receipts,downloads,return-labels,statements,artifacts}`; artifacts pipeline (screenshots, PDFs, labels) with Neon pointers; text extraction from PDFs |
| X2 Executor | `lib/executor/` | Executor MCP client (passthrough mode); create a Google Calendar event after booking/return; `.ics` fallback; rule "API → Executor, website only → Kernel" in the workflow |
| X3 Return flow on demo site | `demo-site/store/` | Orders → headphones → eligibility → reason → refund destination → final submit → QR label download |
| X4 Return skill | `lib/skills/seeds/return*` | Return Online Purchase skill with preferences (original payment, UPS Store, QR label) that change execution; label saved to the Sprite; calendar drop-off reminder via Executor |
| V6 Verifier | — | "Return these headphones" end to end; label in the Sprite; calendar event created |

## S7 — Phase 6b: Teach Mode (side by side with S6)

| Agent | Owns | Task |
|---|---|---|
| T1 Extension | `extension/` | Chrome MV3 extension: record clicks/inputs/navigation with element text, role, and nearby labels; redact passwords; send to the app |
| T2 Ingest | `app/api/teach/`, `lib/teach/` | Receive recordings, reuse K2 to normalize them into a skill, ask for a name/trigger phrases |
| T3 Teach UI | `app/(dashboard)/teach/` | "Teach a new skill" screen: start/stop recording, review the generated steps, save |
| V7 Verifier | — | Teach a new demo chore by hand → agent replays it through Kernel |

**Gate S6+S7:** all 8 sponsors doing real work; two skills demoable; Teach Mode works.

---

## S8 — Phase 7: Ship

| Agent | Owns | Task |
|---|---|---|
| R1 README | `README.md`, `docs/` | Judge-ready README: problem, solution, demo, Mermaid architecture, sponsor-by-sponsor "why it's necessary", Observe → Learn → Store → Trigger → Replay → Verify → Heal, screenshots |
| R2 Deploy + hardening | `Dockerfile`, `fly.toml`, `.github/` | Deploy the app to Fly; secrets; demo reset button; warm-up for Kernel/Sprite; failure fallbacks |
| R3 Demo rehearsal | `docs/DEMO_SCRIPT.md` | Run the judging narration end to end 3× on the deployed app, timing each beat, and log every hiccup |
| R4 Screenshots/video | `docs/screenshots/` | Capture every screen for the README; optional recorded backup video of the demo |

**Gate S8:** the deployed app runs the full narration without touching a terminal.

---

## What I need from you, and by when

| Needed | For | By session |
|---|---|---|
| Nothing new — Kernel, Neon, Exa, AgentMail, Mastra, Assistant UI keys are in `.env` | S1–S4 | — |
| `fly auth login` working locally (for deploying the demo site) | S1 | S1 |
| Neon plan answer (paid → AI Gateway embeddings; free → OpenAI/Mastra embeddings) | S3 | S3 |
| `SPRITES_TOKEN` | S6 | S6 |
| Executor Cloud account + Google Calendar connected + `EXECUTOR_API_KEY`, `EXECUTOR_MCP_URL` | S6 | S6 |

## Rules for every session
1. Read `docs/PLAN.md`, `docs/CONTRACTS.md`, `docs/HANDOFF.md`, then the relevant skills.
2. Change a contract only in the lead, never inside a sub-agent.
3. Never trust an LLM "done": every run needs explicit verification evidence.
4. Commit at every gate, then write a short DONE / NEXT / BLOCKER note to `docs/HANDOFF.md`.
5. Priority order: working > visible > reliable > sponsor-integrated > generalized.
