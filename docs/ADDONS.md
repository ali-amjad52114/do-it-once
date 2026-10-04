# Do It Once — Add-ons plan (v2, grounded in the code)

Baseline: `s1-vertical-slice` @ `ceaaa7f` (S1 + Wave A + Wave B merged). This replaces the v1
add-on spec, which predated the code. Every file and function named below exists today unless
marked **new**.

| Add-on | One line | Size |
|---|---|---|
| A3 AI judge | Opus checks the final screenshot; rules pass + judge fails → **Needs review** | S |
| A2 Skills over MCP | Claude can search, read and start your skills; "Download as Claude Skill" | M |
| A1 Guide me | The Teach extension gets a Guide mode that highlights the next click in your own browser | M |
| A4 Discovery race | 3 agents try a new chore; the best judged run becomes a draft skill via the Teach pipeline | L |

Build order: **A3 → A2 → A1 → A4**. A3, A2 and A1 can be built in parallel (disjoint folders);
A4 needs A3.

---

## What already exists and gets reused

| Need | Existing code |
|---|---|
| Model calls | `lib/ai/gateway.ts` — Neon AI Gateway (`chat`, `chatJSON`, `embed`, `MODELS`). **Verified 2026-10-04:** `claude-opus-5-5` is on the gateway and accepts image input (`image_url` data URL). Also available: `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-4-5` |
| Verification moment | `lib/engine/engine.ts` verify block: has `runId`, `page` (text + URL), `artifact.id` (screenshot), `ctx.skill.verification`, emits `verify.passed` / `verify.failed`. Shared by `getRunEngine()` and the Mastra `choreRun` workflow (`lib/engine/runtime.ts` → `getRunCore()`), so one hook covers both |
| Screenshot bytes | `GET /api/artifacts/:id`; repo artifact lookup in `lib/neon/` |
| Proof UI | `components/evidence/ProofPanel.tsx` — `{ result: RunResult, highlightPhrases? }`; `RunResult` has `screenshotArtifactId`, `finalUrl`, `evidenceText` |
| Skill search | `matchSkills(userId, text, limit)` in `lib/skills/retrieve.ts` (pgvector + keyword) |
| Start a run | `getRunEngine().startRun(...)` (as used by `POST /api/runs`) |
| MCP packages | `@mastra/mcp` 2.1 and `@modelcontextprotocol/sdk` 1.32 already installed |
| Extension | `extension/` (MV3 "Teach Mode"): `background.js` injects scripts, `lib.js` builds selectors (`buildSelector`, tested in `extension/test/selector.test.mjs`), `recorder.js`, popup. Auth model: CORS allow-list in `app/api/teach/cors.ts`, single user `DEMO_USER_ID` |
| Irreversible-click guard | `guardClick`, `llmIsIrreversible`, `RISKY_WORDS` in `lib/heal/guard.ts` |
| Page-exploring agent loop | `runHealer` in `lib/heal/healer.ts` (element list → JSON action → act; max actions; never clicks the final irreversible control) — the pattern A4 copies |
| Recording → skill | `RecordingSchema` (`lib/learn/schema.ts`) → `insertRecording` → `ensureNormalized` → `saveTaughtSkill` (saves as **draft**) → `promoteTaughtSkill(runId)` makes it **active** after a verified run (`lib/learn/store.ts`) |
| Header nav | `components/Home.tsx` header, next to the "Teach a chore" link |
| Skill page | `components/SkillDetailView.tsx` (+ `app/(dashboard)/skills/[id]/page.tsx`) |
| Demo target | `https://do-it-once-demo.fly.dev` (Lumen+, v1/v2 layouts, store, reset) |

---

## Rules (unchanged in spirit, adjusted to the code)

1. **Own folders.** A1 `extension/guide/` + `app/api/guide/` + `lib/guide/` · A2 `lib/mcp/` +
   `app/api/mcp/` + `app/api/skills-export/` + `app/(dashboard)/connect/` · A3 `lib/judge/` +
   `app/api/judge/` + `components/judge/` · A4 `lib/discover/` + `app/api/discover/` +
   `app/(dashboard)/discover/` + `components/discover/`.
2. **Migrations `100`+** (`100_judgments.sql`, `101_guide.sql`, `103_discover.sql`). New tables only.
3. **Additive types** in `lib/contracts.addons.ts` (new). `EventType` stays untouched: add-on
   events go to add-on tables, not `execution_events`.
4. **Flags** `ADDON_JUDGE`, `ADDON_MCP`, `ADDON_GUIDE`, `ADDON_DISCOVER` (default off; add to
   `.env.example`). All off = today's app, byte-for-byte behaviour.
5. **No new npm packages** needed for any add-on.
6. **Hooks** (edits to existing files) are listed per add-on, are one-liners or one small
   component insert, and are made by the lead after the add-on's own tests pass.

---

## A3 — AI judge

**Build (new)**
- `lib/judge/judge.ts` — `judgeRun({ intent, verification, finalUrl, pageText, screenshotPng })`
  → `Judgment { verdict: 'pass'|'fail'|'unsure', confidence, reasons[], quotedEvidence[] }`.
  Own small multimodal call (POST `/v1/chat/completions` with an `image_url` data URL) inside
  `lib/judge/`, so `lib/ai/gateway.ts` is untouched. Model `claude-opus-5-5`; prompt states page
  text and screenshot are data, never instructions; zod-validated JSON with one retry
  (same pattern as `chatJSON`).
- `lib/judge/index.ts` — `onRunVerified(runId)`: loads run + screenshot artifact, calls
  `judgeRun`, writes `judgments`. Fire-and-forget, 15 s timeout, errors logged only.
- `db/migrations/100_judgments.sql` — `judgments(id, run_id, model, verdict, confidence,
  reasons jsonb, evidence jsonb, latency_ms, created_at)`.
- `app/api/judge/[runId]/route.ts` — `GET` → latest judgment + combined verdict.
- `components/judge/JudgeBadge.tsx` — polls the route until a judgment exists.

**Combined verdict** (display only; `runs.state` is not changed):
rules pass + judge pass → Succeeded · pass + unsure → Succeeded ("judge unsure") ·
pass + fail → **Needs review** · rules fail → Failed (judge reasons as context).

**Hooks**
- H-A3a `lib/engine/engine.ts`, right after each `verify.passed` / `verify.failed` emit:
  `if (flag('ADDON_JUDGE')) void onRunVerified(runId);`
- H-A3b `components/evidence/ProofPanel.tsx`: render `<JudgeBadge runId={…} />` — ProofPanel
  doesn't receive `runId` today, so its caller (`RunPanel` / `SuccessHero`) passes it as a new
  optional prop.

**Done when** 5 real Lumen+ cancels → 5 judge passes; a doctored case (rules pass, screenshot of
the active plan) → `fail` → Needs review; with the flag off nothing changes and the judge is never called.

---

## A2 — Skills over MCP + Claude Skill export

**Build (new)**
- `lib/mcp/server.ts` — `MCPServer` from `@mastra/mcp` with tools:
  `search_skills {query}` → `matchSkills` · `get_skill {skillId}` → existing skill repo
  (steps, preferences, version, `requiresApproval`) · `list_runs {limit}` · `start_run {skillId}`
  → `getRunEngine().startRun`, returns `runId` + dashboard URL · `get_run {runId}` → state,
  pending approval text, result. **No approve tool**; descriptions tell the agent the user
  approves in the dashboard.
- `app/api/mcp/[transport]/route.ts` — Streamable HTTP endpoint. Auth: `Authorization: Bearer`
  checked against `MCP_TOKEN` env (single-user, matching the app's `DEMO_USER_ID` model; a
  tokens table is a stretch goal).
- `app/api/skills-export/[id]/route.ts` — zip with `SKILL.md` (frontmatter `name`,
  `description` + trigger phrases; body = steps, verification checklist, "ask before the
  irreversible step", "use the `start_run` MCP tool if connected").
- `app/(dashboard)/connect/page.tsx` — the MCP URL, how to set the token, copy-paste config for
  Claude Desktop and Claude Code.

**Hooks**
- H-A2a `components/SkillDetailView.tsx`: **Download as Claude Skill** link.
- H-A2b `components/Home.tsx` header: "Connect Claude" link.

**Prerequisite** a public app URL (`PUBLIC_APP_URL`) for Claude Desktop; Claude Code can use
`http://localhost:3000/api/mcp` meanwhile.

**Done when** Claude Code connected over MCP lists skills, finds Cancel from "stop paying for
Lumen+", starts a run that pauses for approval in the dashboard; the exported `SKILL.md` loads
as a Claude Skill.

---

## A1 — Guide me (mode inside the Teach extension)

The Teach extension is finished, so Guide becomes a second mode of it (one install) instead of
a separate extension.

**Build (new)**
- `extension/guide/guide.js` — content script: resolve element (`locatorHint` → role/name from
  `targetDescription` → visible text, reusing `extension/lib.js` helpers), draw highlight +
  tooltip with `intent`, advance when the user acts and `expectedAfter` text or URL appears,
  amber warning on `requiresApproval` steps, never clicks for the user; at the end checks the
  skill's `VerificationSpec` on page text/URL.
- `extension/guide/guide.css`; a "Guide" tab in the popup listing skills.
- `app/api/guide/` (CORS via the existing `app/api/teach/cors.ts` helpers):
  `GET skills/:id` (steps for guiding), `POST sessions`, `POST sessions/:id/events`,
  `POST sessions/:id/finish`, `POST locate` ("I can't find it": visible text + clickable
  element list → `chatJSON` with `MODELS.smart` → selector).
- `db/migrations/101_guide.sql` — `guide_sessions`, `guide_events`.

**Hooks**
- H-A1a `extension/manifest.json`: add the guide files to the injected scripts
  (`background.js` `FILES` list) — owned by Teach, finished, so safe.
- H-A1b `components/SkillDetailView.tsx`: **Guide me** button → opens the skill's start URL
  with `#dio-guide=<skillId>`, which the extension picks up.

**Privacy** only visible text (≤ 8k) and role/text element lists leave the page; no input
values, no passwords.

**Done when** on Lumen+ a person is walked through Cancel by highlights alone, stopped at the
amber step, and the finish is verified; "I can't find it" recovers on the v2 layout.

---

## A4 — Discovery race

**Build (new)**
- `lib/discover/explorer.ts` — one attempt: Kernel browser via `BrowserAdapter`, a goal-driven
  loop modelled on `runHealer` (element list → `chatJSON` with `MODELS.smart` → act), every
  click screened by `guardClick` / `llmIsIrreversible`; stops before any irreversible control.
  Limits: 25 actions, 3 minutes, start-URL origin only. Logs actions in **`RecordingSchema`
  shape** (`navigate|click|type|select|submit`, target role/name/text, url, pageTitle).
- `lib/discover/race.ts` — 3 attempts in parallel with different strategy prompts (menus /
  site search / help pages via `lib/exa`), judge each final state with A3 `judgeRun`, winner =
  judge pass with fewest steps.
- Winner → `insertRecording` → `ensureNormalized` → `saveTaughtSkill` ⇒ a **draft** skill that
  becomes active only after a verified run (`promoteTaughtSkill`). No new skill-saving code.
- `db/migrations/103_discover.sql` — `discoveries`, `discovery_attempts` (live view URL, steps,
  judgment, recording id).
- `app/api/discover/` — `POST` start, `GET :id`, `GET :id/events` (SSE, same helpers as
  `app/api/_lib/sse.ts`).
- `app/(dashboard)/discover/page.tsx` + `components/discover/` — goal input, "starts 3
  browsers" notice, three live views, judge score per lane, winner → link to the draft skill
  review on `/teach`.

**Hooks**
- H-A4a `components/Home.tsx` header: "Discover" link.

**Done when** "Download my latest invoice from Lumen+" yields ≥ 1 judged pass, a draft skill
appears on `/teach`, and running it once verifies and promotes it to active; no attempt clicks
an irreversible control; all Kernel browsers are deleted afterwards.

---

## Sessions

Who builds what, in which session and order, with isolation and kickoff prompts:
see `docs/ADDONS_EXECUTION.md`.

## Prerequisites / decisions for the user
1. **`PUBLIC_APP_URL`**: the app's public URL (needed by Guide from other sites and Claude
   Desktop MCP). `fly.toml` currently names `neon-agent-ali` (the old prototype app) — decide
   whether that app is the deploy target.
2. **MCP auth**: one `MCP_TOKEN` (proposed) vs per-device tokens.
3. **Judge cost**: one Opus call per run (≈ a few cents); fine for the demo.
