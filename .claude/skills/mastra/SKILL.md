---
name: mastra
description: Mastra (mastra.ai) v1.x TypeScript agent/workflow framework as used in "Do It Once". Use when writing or debugging Mastra workflows (createWorkflow/createStep, suspend/resume human approval, streaming run events), the Mastra instance and PostgresStore (Neon) persistence, resuming runs after a restart, Mastra agents/tools/structured output, the `mastra/...` model gateway, embeddings, or calling Mastra from Next.js route handlers.
---

# Mastra (v1.x) for Do It Once

Checked 2026-10-04 against installed `@mastra/core@1.74.0`, `@mastra/pg@1.29.0`, `@mastra/memory@1.35.0`.
Snippets marked **[verified]** were run against the installed package (in-memory store, two `Mastra`
instances sharing one store to simulate a restart). **[types]** = checked against `.d.ts` only.
**[unverified]** = from docs/search, not exercised here.

## Sources (read these before guessing)
- **Official Mastra skill** (exists): `npx skills add mastra-ai/skills`, https://github.com/mastra-ai/skills,
  https://mastra.ai/.well-known/skills/mastra/SKILL.md. Its main rule: don't trust memory; check the
  **embedded docs for the installed version** first.
- **Embedded docs (version-exact, best source):** `node_modules/@mastra/core/dist/docs/references/*.md`
  (also `@mastra/pg/dist/docs`). Useful files: `docs-workflows-suspend-and-resume.md`,
  `docs-workflows-human-in-the-loop.md`, `docs-workflows-snapshots.md`, `reference-streaming-workflows-stream.md`,
  `reference-streaming-workflows-resumeStream.md`, `integrations-databases-postgresql.md`,
  `integrations-frameworks-next-js.md`, `reference-tools-create-tool.md`, `docs-agents-structured-output.md`,
  `reference-rag-embeddings.md`, `reference-migrations-upgrade-to-v1-workflows.md`.
- Remote index: https://mastra.ai/llms.txt (append `.md` to doc URLs for markdown), e.g.
  https://mastra.ai/docs/workflows/suspend-and-resume.md, https://mastra.ai/docs/workflows/human-in-the-loop.md,
  https://mastra.ai/docs/workflows/snapshots.md, https://mastra.ai/integrations/databases/postgresql.md,
  https://mastra.ai/integrations/frameworks/next-js.md, https://mastra.ai/docs/deployment/web-framework,
  https://mastra.ai/models/gateways.md, https://mastra.ai/reference/tools/create-tool.md
- Types of truth: `node_modules/@mastra/core/dist/workflows/workflow.d.ts` (`Workflow`, `Run`),
  `dist/workflows/step.d.ts` (`ExecuteFunctionParams`), `dist/stream/types.d.ts` (`WorkflowStreamEvent`).

## Imports (v1 subpath exports)
```ts
import { Mastra } from '@mastra/core'                       // also '@mastra/core/mastra'
import { createWorkflow, createStep } from '@mastra/core/workflows'
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { ModelRouterEmbeddingModel } from '@mastra/core/llm'
import { InMemoryStore } from '@mastra/core/storage'        // tests only
import { PostgresStore, PgVector } from '@mastra/pg'
import { Memory } from '@mastra/memory'
import { z } from 'zod'                                      // repo uses zod v4; any Standard Schema works
```

## Chore-run workflow with an approval gate  [verified]
Pipeline: trigger -> intent -> retrieve skill -> prepare -> browser steps -> verify -> **approve (suspend)** -> complete.
```ts
const prepare = createStep({
  id: 'prepare',
  inputSchema: z.object({ userId: z.string(), request: z.string() }),
  outputSchema: z.object({ skillId: z.string(), plan: z.string() }),
  execute: async ({ inputData, writer }) => {
    await writer?.write({ type: 'progress', msg: 'retrieving skill' }) // -> 'workflow-step-output' event
    return { skillId: 'pay-electric-bill', plan: `plan for ${inputData.request}` }
  },
})

const approve = createStep({
  id: 'approve',
  inputSchema: z.object({ skillId: z.string(), plan: z.string() }),
  outputSchema: z.object({ skillId: z.string(), approved: z.boolean() }),
  suspendSchema: z.object({ reason: z.string(), plan: z.string(), screenshotUrl: z.string().optional() }),
  resumeSchema: z.object({ approved: z.boolean(), note: z.string().optional() }),
  execute: async ({ inputData, resumeData, suspend, bail }) => {
    if (resumeData?.approved === false) return bail({ skillId: inputData.skillId, approved: false }) // ends run, status 'success'
    if (!resumeData) return await suspend({ reason: 'Approve final submit?', plan: inputData.plan })
    return { skillId: inputData.skillId, approved: true }
  },
})

const complete = createStep({
  id: 'complete',
  inputSchema: z.object({ skillId: z.string(), approved: z.boolean() }),
  outputSchema: z.object({ done: z.boolean() }),
  execute: async ({ inputData, getStepResult, getInitData, state, setState, runId, mastra, abortSignal }) => {
    // getStepResult('prepare') / getStepResult(prepare), getInitData(), runId, mastra, requestContext are all available
    return { done: true }
  },
})

export const choreRun = createWorkflow({
  id: 'chore-run',
  inputSchema: z.object({ userId: z.string(), request: z.string() }),
  outputSchema: z.object({ done: z.boolean() }),
})
  .then(prepare)
  .then(approve)
  .then(complete)
  .commit() // required
```
Control flow (all exist on `Workflow` in 1.74 [types]): `.then(step)`, `.parallel([a, b])`,
`.branch([[async ({ inputData }) => cond, stepA], [async () => true, stepB]])`,
`.dountil(step, async ({ inputData, iterationCount }) => done)`, `.dowhile(...)`, `.foreach(step, { concurrency })`,
`.map(...)`, `.sleep(ms)`. Step outputs must match the next step's `inputSchema` (inputs are validated by default in v1).
Keep snapshot payloads small and JSON-serializable: store Kernel session IDs / screenshot URLs, not blobs.

## Mastra instance + Neon persistence
```ts
// src/mastra/index.ts
export const mastra = new Mastra({
  storage: new PostgresStore({ id: 'neon-storage', connectionString: process.env.DATABASE_URL! }),
  workflows: { choreRun },          // key used by mastra.getWorkflow('choreRun')
  agents: { intentAgent },
})
```
- Snapshots go to the `mastra_workflow_snapshot` table (unique on workflow_name + run_id; found in the installed pg build) keyed by `runId` + workflow name.
  Tables are auto-created on init (`disableInit: true` to opt out). Other `PostgresStore` options: `pool`, `schemaName`,
  `ssl`, `max`, `idleTimeoutMillis`. Prefer Neon's **pooled** connection string. [types/docs]
- Without `storage` there is no restart survival. Never use LibSQL file storage on serverless.
- `agent.mjs` already builds a second `PostgresStore` for `Memory`; prefer one store: `new Memory({ storage: mastra.getStorage() })`
  or just register storage on Mastra and let agents inherit it. [unverified that inheritance covers Memory without explicit storage]

## Start, read state, resume after restart  [verified]
```ts
const wf = mastra.getWorkflow('choreRun')
const run = await wf.createRun({ resourceId: userId })      // optional runId; returns Promise<Run>
const result = await run.start({ inputData: { userId, request } })
if (result.status === 'suspended') {
  const [stepId] = result.suspended[0]                         // e.g. ['approve'] (path; nested = ['wf','step'])
  const payload = result.steps[stepId].suspendPayload          // { reason, plan }
}
// result.status: 'success' | 'failed' | 'suspended' | 'tripwire' | 'canceled' | ...; success -> result.result

// ---- later, different process / after redeploy ----
const wf2 = mastra.getWorkflow('choreRun')
const state = await wf2.getWorkflowRunById(runId)             // WorkflowState | null
// state.status === 'suspended'; state.steps.approve.suspendPayload; state.payload; state.result
const { runs } = await wf2.listWorkflowRuns({ status: 'suspended', resourceId: userId }) // also fromDate/toDate/perPage/page
const run2 = await wf2.createRun({ runId })                    // rehydrates from the persisted snapshot
const done = await run2.resume({ step: 'approve', resumeData: { approved: true } }) // step: id | step obj | path array
```
Other `Run` methods [types]: `startAsync()` -> `{ runId }` (fire-and-forget), `resumeAsync()`, `cancel()`,
`restart()`, `timeTravel()`. On `Workflow`: `listActiveWorkflowRuns()`, `restartAllActiveWorkflowRuns()`, `deleteWorkflowRunById()`.
Raw snapshot: `(await mastra.getStorage()?.getStore('workflows'))?.loadWorkflowSnapshot({ runId, workflowName })` [docs].

## Streaming progress for the UI  [verified]
```ts
const output = run.stream({ inputData })                       // not awaited; returns WorkflowRunOutput
for await (const ev of output.fullStream) {                    // iterating `output` directly is deprecated
  // ev.type: workflow-start | workflow-step-start | workflow-step-output | workflow-step-result
  //          | workflow-step-suspended | workflow-step-progress (foreach) | workflow-finish
  // ev.payload carries step id / output / status
}
const final = await output.result                              // WorkflowResult; output.status, output.usage
const resumed = run2.resumeStream({ step: 'approve', resumeData: { approved: true } }) // same shape
```
`stream()` closes on suspend by default (`closeOnSuspend: true`). `run.observeStream()` re-attaches to a live run
in the same process only; after refresh, rehydrate with `getWorkflowRunById` then poll/stream. For AI-SDK UIs,
`@mastra/ai-sdk` provides `workflowRoute` / snapshot-to-stream helpers (not installed) [unverified].

## Next.js route handlers  [unverified in this repo — no Next app yet]
```ts
// next.config.ts — Mastra uses Node-only deps
const nextConfig = { serverExternalPackages: ['@mastra/*'] }
export default nextConfig
```
```ts
// app/api/runs/route.ts
export const runtime = 'nodejs'
import { mastra } from '@/mastra'
export async function POST(req: Request) {
  const { userId, request } = await req.json()
  const run = await mastra.getWorkflow('choreRun').createRun({ resourceId: userId })
  const output = run.stream({ inputData: { userId, request } })
  const enc = new TextEncoder()
  const body = new ReadableStream({
    async start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'run', runId: run.runId })}\n\n`))
      for await (const ev of output.fullStream) c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`))
      c.close()
    },
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
}
// app/api/runs/[runId]/route.ts  (Next 15+: params is a Promise)
export async function GET(_: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params
  return Response.json(await mastra.getWorkflow('choreRun').getWorkflowRunById(runId))
}
// app/api/runs/[runId]/approve/route.ts
export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params
  const { approved } = await req.json()
  const run = await mastra.getWorkflow('choreRun').createRun({ runId })
  return Response.json(await run.resume({ step: 'approve', resumeData: { approved } }))
}
```
- Export a single `mastra` from `src/mastra/index.ts`; in dev, cache it on `globalThis` to avoid many pg pools on HMR.
- Long browser steps can exceed serverless timeouts; on Fly.io (this repo deploys there) a long-lived Node server is fine.
  On Vercel use `startAsync()` and poll `getWorkflowRunById`.
- Official Next guide uses `mastra init` + `@mastra/ai-sdk` `handleChatStream` for agent chat routes.

## Agents, tools, structured output
```ts
const fillForm = createTool({
  id: 'fill-form',
  description: 'Fill a form field in the Kernel browser',
  inputSchema: z.object({ selector: z.string(), value: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
  // v1: (validatedInput, context). context = { requestContext, abortSignal, mastra, writer, agent, workflow, ... }
  execute: async ({ selector, value }, { requestContext, abortSignal }) => ({ ok: true }),
  // requireApproval: true  -> agent emits tool-call-approval and pauses (agent-level HITL)
})

export const intentAgent = new Agent({
  id: 'intent-agent', name: 'Intent Agent',
  instructions: 'Classify the chore request.',
  model: 'mastra/openai/gpt-5-mini',   // "<gateway>/<provider>/<model>"; or 'openai/gpt-5-mini' with OPENAI_API_KEY
  tools: { fillForm },
})
const res = await intentAgent.generate(prompt, {
  structuredOutput: { schema: z.object({ intent: z.string(), skillQuery: z.string() }) },
})
res.object // typed
```
- Gateway: `mastra/...` model strings use `MASTRA_GATEWAY_API_KEY` (also recognized in core: `MASTRA_GATEWAY_URL`,
  `MASTRA_GATEWAY_ID`). Existing `agent.mjs` already works this way. See https://mastra.ai/models/gateways.md.
- Agent as a step: `createStep(intentAgent, { structuredOutput: { schema } })` -> step input `{ prompt: string }`; use `.map()` to shape input.
- Tool as a step: `createStep(fillForm)`.
- Agent-level HITL (tool approval) survives restart too: `agent.listSuspendedRuns({ resourceId })` then
  `agent.approveToolCall({ runId, toolCallId })` / `declineToolCall` (added 1.43.0) [docs]. For Do It Once, prefer the
  workflow `suspend()` gate: it is explicit and visible in run state.

## Embeddings for skill retrieval  [types; runtime unverified]
```ts
const embedder = new ModelRouterEmbeddingModel('openai/text-embedding-3-small') // needs OPENAI_API_KEY
const { embeddings } = await embedder.doEmbed({ values: [text] })
// Or with the `ai` package (not installed): embed({ model: embedder, value: text })
// Store in Neon pgvector via PgVector from '@mastra/pg' or plain SQL `vector(1536)` + `<=>` ordering.
```
Known IDs in 1.74: `openai/text-embedding-3-small|large`, `openai/text-embedding-ada-002`, `google/gemini-embedding-001`.

## 0.x -> 1.x gotchas
- `createRunAsync()` -> **`createRun()`** (async, await it). `getWorkflows` -> `listWorkflows`, `getWorkflowRuns` -> `listWorkflowRuns`.
- `run.watch()` / legacy watch events removed (still in `.d.ts` as `@internal`): use `stream()` / `resumeStream()` / `observeStream()`.
  `streamVNext` / `resumeStreamVNext` removed; event names are `workflow-*` prefixed.
- `RuntimeContext` -> `RequestContext`; step `runCount` -> `retryCount`; `writableStream` -> `outputWriter`.
- `setState()` is async and validated; `getInitData()` returns unknown unless typed; `suspendPayload` validated against `suspendSchema`.
- Tool `execute` is `(input, context)`, not `({ context })` as in 0.x. Storage/vector constructors require an `id`.
- `suspend()`/`setState()` are not available inside `.branch`/loop condition functions.
- `bail()` ends the run with status `success` (check `result.result`, not status, for rejection).
- Codemods: `npx @mastra/codemod@latest v1/...` (see `reference-migrations-upgrade-to-v1-*.md`).

## Open questions
- `mastra/...` gateway support for embeddings (only direct provider IDs are typed) - test before relying on it.
- PostgresStore end-to-end against Neon not exercised in this check (only InMemoryStore); confirm that pooled
  (pgbouncer) URLs work for init DDL.
- Best way to re-attach a live progress stream after a page refresh mid-run (non-suspended) across processes.
