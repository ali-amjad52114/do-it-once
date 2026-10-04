# Add-ons — multi-session, multi-agent execution plan

What to build is in `docs/ADDONS.md` (v2). This file says **who builds it, in which session,
in what order, and how they stay out of each other's way** (and out of the main build's way).

Read order for every add-on session: `docs/PLAN.md` (rules) → `docs/CONTRACTS.md` →
`docs/ADDONS.md` → this file → `docs/HANDOFF.md` → the sponsor skills it needs
(`.claude/skills/<name>/SKILL.md`).

---

## Session map

```
X0  Setup (lead, short)  ── decisions, flags, branches, Neon branches, contracts.addons.ts
 │
 ├──► X1  Judge  (A3)   ─────────────┐
 ├──► X2  MCP    (A2)                │   X1–X3 run side by side
 ├──► X3  Guide  (A1)                │
 │                                   ▼
 │                         X4  Discovery race (A4)  (starts when X1 is merged)
 │                                   │
 └───────────────────────────────────┴──► X5  Integrate + verify + demo
```

| Session | Builds | Sub-agents | Side by side with | Starts when |
|---|---|---|---|---|
| X0 | Setup | lead only | — | now |
| X1 | A3 Judge | 2 + verifier = **3** | X2, X3 | X0 done |
| X2 | A2 MCP + Claude Skill | 2 + verifier = **3** | X1, X3 | X0 done |
| X3 | A1 Guide me | 2 + verifier = **3** | X1, X2 | X0 done |
| X4 | A4 Discovery | 3 + verifier = **4** | X2, X3 (if still running) | X1 merged |
| X5 | Hooks, flags, e2e, demo beats | 1 + verifier = **2** | — | X1–X4 merged |
| | | **15 agents** | max 3 sessions at once | |

Why 3 at once, not 5: Kernel browsers (≤ 5 concurrent across *everything*, including the main
build), Neon AI Gateway rate limits, and merge load on the lead.

---

## Isolation (one row per session)

| | X1 Judge | X2 MCP | X3 Guide | X4 Discover | X5 |
|---|---|---|---|---|---|
| Git branch (from latest `s1-vertical-slice`) | `addon/judge` | `addon/mcp` | `addon/guide` | `addon/discover` | `addon/integrate` |
| Neon branch | `addon-judge` | `addon-mcp` | `addon-guide` | `addon-discover` | `addon-integrate` |
| Env file | `.env.x1` | `.env.x2` | `.env.x3` | `.env.x4` | `.env.x5` |
| `next dev` port | 3011 | 3012 | 3013 | 3014 | 3015 |
| Demo site | local 4011 + tunnel | none needed | local 4013 (no tunnel; the user's browser) | local 4014 + tunnel | Fly demo |
| Kernel browsers (max) | 1 | 1 (one `start_run` test) | 0 | 3 | 1 |
| Migration numbers | 100 | 102 (reserved, likely unused) | 101 | 103 | — |
| Owns | `lib/judge/`, `app/api/judge/`, `components/judge/` | `lib/mcp/`, `app/api/mcp/`, `app/api/skills-export/`, `app/(dashboard)/connect/` | `extension/guide/`, `app/api/guide/`, `lib/guide/` | `lib/discover/`, `app/api/discover/`, `app/(dashboard)/discover/`, `components/discover/` | hooks only (see X5) |

Each env file = a copy of `.env` with `DATABASE_URL` pointing at that session's Neon branch,
`DEMO_SITE_URL` at its own demo site, and its add-on flag set to `1`. Neon branches are
created from the main branch, so they start with the real skills and seed data.

**Never touched by add-on sessions** (except X5, through the listed hooks):
`lib/engine/`, `lib/mastra/`, `lib/ai/`, `lib/learn/`, `lib/heal/`, `lib/skills/`,
`lib/contracts.ts`, `docs/CONTRACTS.md`, `components/` outside the add-on folders,
`extension/` outside `extension/guide/`, `package.json`, migrations below 100.

---

## X0 — Setup (lead, before anything else)

1. Get the user's decisions: public app URL (Fly target), `MCP_TOKEN` approach, OK on Opus
   judge cost (see ADDONS.md "Prerequisites").
2. Write `lib/contracts.addons.ts`: `Judgment`, `CombinedVerdict`, `GuideSession`,
   `GuideEvent`, `Discovery`, `DiscoveryAttempt`, `AddonFlag` + `addonEnabled(flag)` helper.
   Only X0 and X5 edit this file.
3. Create the 4 git branches, 4 Neon branches, 4 env files (table above).
4. Append `ADDON_JUDGE`, `ADDON_MCP`, `ADDON_GUIDE`, `ADDON_DISCOVER`, `MCP_TOKEN` to
   `.env.example` (empty values).
5. Tell the main build lead (HANDOFF note + message): which migration numbers and folders are
   reserved, and that hooks into `engine.ts`, `ProofPanel`, `SkillDetailView`, `Home.tsx`,
   `extension/background.js` happen only in X5.

**Gate X0:** branches + Neon branches exist, `npm run typecheck` passes with the new contracts file.

---

## X1 — Judge (A3)

| Agent | Owns | Task | Done when |
|---|---|---|---|
| J1 Core | `lib/judge/judge.ts`, `lib/judge/*.test.ts`, `lib/judge/fixtures/` | `judgeRun()`: multimodal call to `claude-opus-5-5` on the Neon AI Gateway (own fetch, `image_url` data URL), injection-safe prompt, zod output, one retry, 15 s timeout; `combineVerdict(rulesPassed, judgment)` | Unit tests with a mocked gateway; a live smoke on 2 fixture screenshots (canceled / still active) returns pass / fail |
| J2 Store + API + UI | `db/migrations/100_judgments.sql`, `lib/judge/index.ts`, `lib/judge/repo.ts`, `app/api/judge/`, `components/judge/` | Table + repo; `onRunVerified(runId)` (loads run, artifact bytes, calls `judgeRun`, saves); `GET /api/judge/:runId`; `JudgeBadge` (polls until present, shows pass / unsure / Needs review) | Route test; badge renders all 3 states from mock data |
| VJ Verifier | — | On X1's dev server, run 5 real Lumen+ cancels, calling `onRunVerified` from a script (hooks aren't in yet); plus the doctored case | 5/5 pass, doctored → fail; report latency and cost per call |

**Gate X1:** typecheck, tests, and VJ's report. Lead merges `addon/judge` into `s1-vertical-slice`.

---

## X2 — MCP + Claude Skill export (A2)

| Agent | Owns | Task | Done when |
|---|---|---|---|
| P1 Server | `lib/mcp/`, `app/api/mcp/` | `MCPServer` (`@mastra/mcp`) with `search_skills` (`matchSkills`), `get_skill`, `list_runs`, `start_run` (`getRunEngine().startRun`), `get_run`; Streamable HTTP route; `Bearer MCP_TOKEN` check; no approve tool | MCP Inspector or `@modelcontextprotocol/sdk` client test lists the 5 tools and calls `search_skills` |
| P2 Export + Connect | `app/api/skills-export/`, `app/(dashboard)/connect/` | `SKILL.md` zip per skill; `/connect` page with URL, token instructions, Claude Desktop and Claude Code config snippets | Exported zip for Cancel validates (frontmatter, body); page renders |
| VP Verifier | — | Connect Claude Code to `http://localhost:3012/api/mcp`; "what chores can you do?"; "stop paying for Lumen+" → `start_run` → run pauses for approval in the dashboard | All three behave; no tool can approve |

**Gate X2:** as above. Lead merges `addon/mcp`.

---

## X3 — Guide me (A1)

| Agent | Owns | Task | Done when |
|---|---|---|---|
| G1 Extension | `extension/guide/` | `guide.js` + `guide.css` content script (resolve element via `extension/lib.js` helpers, highlight + tooltip, advance on `expectedAfter` / URL, amber on `requiresApproval`, never clicks, final `VerificationSpec` check); popup "Guide" tab UI as a separate file loaded by the popup (X5 wires it in) | `node --test extension/guide/*.test.mjs` for step matching and advance logic |
| G2 API | `app/api/guide/`, `lib/guide/`, `db/migrations/101_guide.sql` | `GET skills/:id`, `POST sessions`, `POST sessions/:id/events`, `POST sessions/:id/finish`, `POST locate` (`chatJSON`, `MODELS.smart`, visible text + element list only); CORS via `app/api/teach/cors.ts` | Route tests incl. CORS preflight from a `chrome-extension://` origin |
| VG Verifier | — | Loads the unpacked extension in a test profile (the user may need to click "Load unpacked" once), walks Cancel on local Lumen+ (4013) v1 and v2 | Highlights advance through every step; stops amber at cancel; "I can't find it" recovers on v2 |

**Gate X3:** as above. Lead merges `addon/guide`.

---

## X4 — Discovery race (A4)

Starts when `addon/judge` is merged (it calls `judgeRun`).

| Agent | Owns | Task | Done when |
|---|---|---|---|
| D1 Explorer | `lib/discover/explorer.ts` (+ tests) | One attempt: Kernel browser, `runHealer`-style loop with `chatJSON`/`MODELS.smart`, `guardClick` before every click, limits (25 actions, 3 min, one origin), emits actions in `RecordingSchema` shape | Mock-browser tests: obeys limits, stops before an irreversible control, output parses with `RecordingSchema` |
| D2 Race + pipeline + API | `lib/discover/race.ts`, `lib/discover/repo.ts`, `db/migrations/103_discover.sql`, `app/api/discover/` | 3 attempts with strategy prompts (menus / site search / Exa-found help page), `judgeRun` each, pick winner, `insertRecording` → `ensureNormalized` → `saveTaughtSkill` (draft); SSE via `app/api/_lib/sse.ts`; always delete Kernel browsers (`finally`) | Integration test with mocked explorer; live: one discovery on local Lumen+ produces a draft skill |
| D3 UI | `app/(dashboard)/discover/`, `components/discover/` | Goal input, "starts 3 browsers" notice, 3 live-view lanes (Kernel `readOnly` iframes), step counters, judge score, winner card → `/teach` | Renders from mock SSE frames |
| VD Verifier | — | "Download my latest invoice from Lumen+": ≥ 1 judged pass → draft on `/teach` → run it once → verified → promoted to active; kill test at 25 actions; Kernel session count back to 0 | All pass |

**Gate X4:** as above. Lead merges `addon/discover`.

---

## X5 — Integrate, verify, demo

| Agent | Owns | Task |
|---|---|---|
| I1 Integrator | the hook lines only | H-A3a `engine.ts` (judge after verify, flag-guarded) · H-A3b `ProofPanel` + caller pass `runId`, render `JudgeBadge` · H-A2a/H-A1b `SkillDetailView` buttons (Download as Claude Skill, Guide me) · H-A2b/H-A4a `Home.tsx` header links (Connect Claude, Discover) · H-A1a extension `background.js` `FILES` + popup tab · flags on in `.env` · Fly secrets for `MCP_TOKEN` and flags |
| V5 Verifier | — | (1) all flags **off** → the main gates (S1 cancel, S2 chat resume, S4 email card, heal, return, teach) still pass; (2) all flags **on** → full narration: email → run → approve → verified + judge pass → "Guide me" on the same skill → Claude Code via MCP starts a run → Discover produces a draft; (3) `npm run typecheck`, `npm test`, CI green |

Also adds a "Beyond the core" section to `docs/DEMO_SCRIPT.md` (if present) with 4 short beats,
one per add-on.

**Gate X5:** both verifier passes; HANDOFF note; the user decides whether flags are on for judging.

---

## Merge protocol

1. Each session works in its own worktree on its `addon/*` branch, rebased on the latest
   `s1-vertical-slice` before its gate.
2. Merges into `s1-vertical-slice` go through the **main build lead**, one at a time, in order
   X1 → X2 → X3 → X4 → X5, each followed by `npm run typecheck && npm test`.
3. An add-on branch that conflicts with main-build work rebases; it never edits the conflicting
   main-build file to resolve it.
4. Hooks (X5) land last, after the main build has no open session touching those files.

## Kickoff prompts (copy into a new Claude session per row)

**X0:** "You are the add-on lead for C:\AI\Projects\neon. Read docs/PLAN.md, docs/ADDONS.md,
docs/ADDONS_EXECUTION.md and docs/HANDOFF.md. Do session X0 exactly; ask me the 3 decisions
first. Don't touch files outside X0's list."

**X1 / X2 / X3:** "You lead add-on session X<n> in C:\AI\Projects\neon. Read docs/PLAN.md,
docs/CONTRACTS.md, docs/ADDONS.md, docs/ADDONS_EXECUTION.md, docs/HANDOFF.md and the needed
.claude/skills. Use branch addon/<name>, env .env.x<n>, port 30<1n>. Spawn the sub-agents in the
X<n> table in worktrees, each touching only its owned paths, then run the verifier and stop at
the gate with a report. Do not edit hooks or main-build files."

**X4:** same as above with "X4", after confirming `addon/judge` is merged.

**X5:** "You are the add-on integrator. After X1–X4 are merged, do X5: make only the listed
hooks, then run V5's three checks and report."
