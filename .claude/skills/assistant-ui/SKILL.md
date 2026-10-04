---
name: assistant-ui
description: Use when building or changing the "Do It Once" chat/agent UI with assistant-ui (@assistant-ui/react 0.15.x) in Next.js App Router - wiring the runtime to the Mastra backend, the Thread/composer, tool UIs (execution steps, browser live view, Approve/Stop cards for Mastra workflow suspend/resume), data-part renderers, Assistant Cloud thread persistence (ASSISTANT_API_KEY), and Tailwind v4 styling gotchas.
---

# assistant-ui for "Do It Once"

Checked 2026-10-04 against: official agent skills repo `github.com/assistant-ui/skills` (commit 139674d, 2026-10-03),
`https://www.assistant-ui.com/llms.txt`, and the npm tarballs `@assistant-ui/react@0.15.23`, `@assistant-ui/ai-sdk@0.0.9`,
`@assistant-ui/next@0.0.23`, `assistant-cloud@0.2.4` (latest on npm that day; also `ai@7.0.127`, `@mastra/ai-sdk@1.10.6`, CLI `assistant-ui@0.0.119`).
Items marked **[UNVERIFIED]** were not confirmed in docs or source - check before relying on them.

**Official resources (prefer these over memory; the API moves fast):**
- Official skills: `npx skills add assistant-ui/skills` (skills: assistant-ui, setup, elements, primitives, runtime, tools, generative-ui, streaming, cloud, thread-list, ...). `npx assistant-ui@latest create --skills` also installs them.
- Docs MCP server: `npx assistant-ui@latest mcp --claude-code` (hosted at `https://www.assistant-ui.com/mcp`).
- llms.txt: `https://www.assistant-ui.com/llms.txt`; every docs page has a `.md` twin, e.g. `/docs/tools.md`.

## Mental model (0.15.x)

```
Elements (styled, copied into components/assistant-ui/elements/*.aui.tsx by the CLI)
Primitives (unstyled: ThreadPrimitive, ComposerPrimitive, MessagePrimitive)
aui client: useAui / useAuiState / useAuiEvent, scopes via AuiConfig on the provider
Runtime: useChatRuntime (AI SDK v7)  |  useLocalRuntime  |  useExternalStoreRuntime
Backend: our Next route -> Mastra agent/workflows (Neon storage, Kernel browsers)
```

There is NO `@assistant-ui/react-mastra`. Official Mastra path = AI SDK runtime: client `useChatRuntime` from
`@assistant-ui/ai-sdk`, server route streams `agent.stream()` through `toAISdkStream` from `@mastra/ai-sdk`.
Use `useLocalRuntime` (ChatModelAdapter) or `useExternalStoreRuntime` only if we abandon the AI SDK wire format.

## Install / scaffold

Repo note (2026-10-04): `package.json` lists `assistant-cloud` but NOT `@assistant-ui/react`, and there is no Next app yet.

```bash
npx create-next-app@latest web --ts --tailwind --app   # or reuse an existing Next app
npx assistant-ui@latest init -y                         # existing project: shadcn setup, Thread, TS paths, theme vars
npm i @assistant-ui/react @assistant-ui/ai-sdk ai @mastra/ai-sdk zod
npx assistant-ui@latest add thread thread-list          # -> components/assistant-ui/elements/thread.aui.tsx etc.
npx assistant-ui@latest add elements-approval-card elements-agent-plan elements-agent-status   # optional standalone elements
npx assistant-ui@latest doctor                          # version drift check
```
`init`/`create` prompt in a TTY; in an agent shell always pass `-y` (and `-t <template>` for `create`).

## Server: Mastra -> AI SDK UI message stream (full-stack, in-process)

```js
// next.config.mjs  - Mastra uses Node-only modules; without this you get opaque bundling errors
export default { serverExternalPackages: ["@mastra/*"] };
```

```ts
// app/api/chat/route.ts
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { toAISdkStream } from "@mastra/ai-sdk";
import { mastra } from "@/mastra";

export const runtime = "nodejs";
export async function POST(req: Request) {
  const { messages } = await req.json();
  const agent = mastra.getAgent("choreAgent"); // key in new Mastra({ agents: { choreAgent } })
  const stream = await agent.stream(messages);   // pass memory/threadId opts here for Neon memory
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      originalMessages: messages,
      execute: async ({ writer }) => {
        for await (const part of toAISdkStream(stream, { from: "agent" })) await writer.write(part);
        // custom progress can be pushed as data parts, e.g.
        // writer.write({ type: "data-step", data: { label: "Opened billing page", status: "done" } });
      },
    }),
  });
}
```
Separate-server variant: `chatRoute({ path: "/chat/:agentId" })` from `@mastra/ai-sdk` in `server.apiRoutes`, CORS on
the Mastra server, client uses `new AssistantChatTransport({ api: process.env.NEXT_PUBLIC_MASTRA_URL })`.
`:agentId` is the object key, not the agent's `name`. Default Mastra port 4111.

## Client: provider + Thread + tool UIs

```tsx
// app/assistant.tsx
"use client";
import { AssistantRuntimeProvider, AuiConfig, Tools } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/ai-sdk";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { choreToolkit } from "./chore-toolkit";
import { StepUI } from "./step-data-ui";

export function Assistant() {
  const runtime = useChatRuntime(); // POSTs to /api/chat via AssistantChatTransport
  const config = AuiConfig({ tools: Tools({ toolkit: choreToolkit }) }); // toolkit must be module-scope/stable
  return (
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      <StepUI />  {/* registers a data-part renderer; renders nothing itself */}
      <div className="grid h-dvh grid-cols-[1fr_420px]">
        <Thread />
        {/* side panel: Kernel live view, skill library, results - read state with useAuiState */}
      </div>
    </AssistantRuntimeProvider>
  );
}
```
Suggestions for the empty state: `AuiConfig({ ..., suggestions: Suggestions(["Get rid of this subscription"]) })`.
Read state anywhere under the provider: `useAuiState((s) => s.thread.isRunning)`; act with
`useAui().thread.append({ role: "user", content: [{ type: "text", text: "..." }] })`.

## Tool UIs (render-only, tools execute in Mastra)

Current API = toolkits. `makeAssistantToolUI` / `useAssistantToolUI` / `makeAssistantTool` / `useAssistantTool` still
exist in 0.15.23 but are **deprecated**. Our tools run in Mastra, so use a plain `"use client"` toolkit with
`type: "backend"` + `render` (no compiler needed). The key MUST equal the Mastra tool name the model sees.

```tsx
// app/chore-toolkit.tsx
"use client";
import { useState } from "react";
import { defineToolkit } from "@assistant-ui/react";

type Suspended = { status: "suspended"; runId: string; step: string; summary: string; liveViewUrl?: string };
type Done = { status: "success" | "failed"; message: string };

export const choreToolkit = defineToolkit({
  // Mastra tool that starts the chore workflow and returns when it suspends for approval or finishes
  run_chore: {
    type: "backend",
    display: "standalone", // keep it out of the collapsed tool group
    render: ({ args, result }) => {
      if (!result) return <p className="text-sm text-muted-foreground">Running "{(args as any)?.goal}"...</p>;
      const r = result as Suspended | Done;
      return r.status === "suspended" ? <ApprovalCard r={r} /> : <p>{r.message}</p>;
    },
  },
  open_browser: {
    type: "backend",
    render: ({ result }) =>
      (result as any)?.liveViewUrl ? (
        <iframe src={(result as any).liveViewUrl} className="h-80 w-full rounded border" allow="clipboard-read; clipboard-write" />
      ) : <p>Starting browser...</p>,
  },
});

function ApprovalCard({ r }: { r: Suspended }) {
  const [state, setState] = useState<"idle" | "sending" | "approved" | "stopped" | "error">("idle");
  const decide = async (approved: boolean) => {
    setState("sending");
    const res = await fetch("/api/runs/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: r.runId, step: r.step, resumeData: { approved } }),
    });
    setState(res.ok ? (approved ? "approved" : "stopped") : "error"); // keep buttons live on error
  };
  if (state === "approved") return <p>Approved - continuing.</p>;
  if (state === "stopped") return <p>Stopped. Nothing was changed.</p>;
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <p className="font-medium">{r.summary}</p>
      <div className="flex gap-2">
        <button disabled={state === "sending"} onClick={() => decide(true)} className="rounded bg-primary px-3 py-1 text-primary-foreground">Approve</button>
        <button disabled={state === "sending"} onClick={() => decide(false)} className="rounded border px-3 py-1">Stop</button>
      </div>
      {state === "error" && <p role="alert" className="text-sm text-destructive">Could not send decision, try again.</p>}
    </div>
  );
}
```

`/api/runs/resume` (ours) rehydrates the Mastra run and calls `run.resume({ step, resumeData })`.
**[UNVERIFIED]** exact Mastra 1.x call shape (`workflow.createRun({ runId })` then `run.resume(...)`) - check Mastra docs.
After resume, either stream progress into the panel (poll/SSE from Neon) or post a follow-up turn with
`aui.thread.append(...)` so the agent reports the result in chat.

Render props available on every tool part: `args`, `argsText`, `result`, `isError`, `status`
(`running | complete | incomplete | requires-action`), `toolName`, `toolCallId`, `addResult`, `resume`,
`interrupt`, `approval`, `respondToApproval`. Unregistered tools fall back to the `ToolFallback` element;
override globally with `<Thread components={{ ToolFallback: MyCard }} />` (hoist the object - inline objects re-render every message).

### Other human-in-the-loop mechanisms (pick by who owns the action)
| Mechanism | Use when | Client call |
|---|---|---|
| `humanTool()` in a `"use generative"` toolkit | user supplies the tool result itself | `addResult(x)` once |
| `human(payload)` inside a `"use client"` executor | frontend tool needs mid-run input | `resume(x)` |
| Approval gate (`approval` on the part) | backend action needs permission; AI SDK v7 `streamText({ toolApproval })` | `await respondToApproval({ approved })` + `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses` |

**[UNVERIFIED]** whether `@mastra/ai-sdk`'s `toAISdkStream` maps Mastra `requireToolApproval` / workflow suspend into AI SDK
approval parts. Until verified, use the custom `ApprovalCard` + resume route above (works regardless).
`humanTool()`/`externalTool()`/`stubTool()` THROW at runtime unless the file starts with `"use generative"` and
`next.config` is wrapped in `withAui` from `@assistant-ui/next` (combine: `withAui({ serverExternalPackages: ["@mastra/*"] })`).

## Data parts (execution steps pushed by the backend, not the model)

```tsx
// app/step-data-ui.tsx
"use client";
import { makeAssistantDataUI } from "@assistant-ui/react";
export const StepUI = makeAssistantDataUI<{ label: string; status: "running" | "done" | "failed" }>({
  name: "step", // **[UNVERIFIED]** that AI SDK part type "data-step" maps to name "step"
  render: ({ data }) => <div className="text-sm">{data.status === "done" ? "✓" : "…"} {data.label}</div>,
});
```
Standalone elements `elements-agent-plan` / `elements-agent-status` / `elements-approval-card` are props-driven UI you can
reuse inside these renderers.

## Assistant Cloud (thread persistence) and ASSISTANT_API_KEY

- `ASSISTANT_API_KEY` = Assistant Cloud server key. **Server-side only**; never `NEXT_PUBLIC_`.
- Client needs `NEXT_PUBLIC_ASSISTANT_BASE_URL=https://proj-<id>.assistant-api.com` (dashboard "Frontend API URL").
- Gives: thread list + message history, auto titles, feedback, file uploads. Adds `<ThreadList />` support.

```tsx
const cloud = useMemo(() => new AssistantCloud({
  baseUrl: process.env.NEXT_PUBLIC_ASSISTANT_BASE_URL!,
  anonymous: true,                       // hackathon/demo; new user per browser session
  // authToken: async () => (await fetch("/api/assistant-token", { method: "POST" })).json().then(r => r.token),
}), []);
const runtime = useChatRuntime({ cloud }); // AssistantCloud is re-exported by @assistant-ui/react
```
```ts
// app/api/assistant-token/route.ts  (JWT mode via API key; server only)
import { AssistantCloud } from "assistant-cloud";
export async function POST() {
  const userId = "demo-user"; // from your auth
  const cloud = new AssistantCloud({ apiKey: process.env.ASSISTANT_API_KEY!, userId, workspaceId: userId });
  const { token } = await cloud.auth.tokens.create();
  return Response.json({ token });
}
```
Cloud stores the CHAT transcript only. Mastra memory (Neon) and workflow snapshots remain our source of truth for
runs/skills; store the cloud thread id in Neon if we need to link them. A thread with no messages is never created.

## Styling / Tailwind / React gotchas

- Elements assume **Tailwind v4** + shadcn theme vars in `globals.css` (`@import "tailwindcss"`, `--background`,
  `--foreground`, `--border`...). `init` writes them; unstyled Thread = missing vars or Tailwind not scanning `components/`.
- `@assistant-ui/styles` and `@assistant-ui/react-ui` are retired - do not install. Styling lives in the copied element files.
- Import path is `@/components/assistant-ui/elements/thread.aui` (old `@/components/assistant-ui/thread` is gone).
- `components.json` `style` decides flavor: `base-*` -> Base UI, else Radix; fix style then `add -o`.
- Peers: react/react-dom `^18 || ^19`; `@assistant-ui/ai-sdk` needs `ai@^7`. Import `useChatRuntime` from
  `@assistant-ui/ai-sdk`, not the legacy `@assistant-ui/react-ai-sdk`.
- Everything using hooks/runtime is a Client Component (`"use client"`); keep Mastra imports in route handlers only.
- Edit Thread CSS vars (`--thread-max-width`, `--composer-*`) in your copy of `thread.aui.tsx`, not from outer classes.
- Tool UI never renders -> toolkit key != tool name, or toolkit not passed via `AuiConfig` on the provider.
- Frontend tool result never reaches the model -> `useChatRuntime({ sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls })`.
- **[UNVERIFIED]** Next 16 specifics: no Next-16-specific caveats found in the official skills; `@assistant-ui/next` has no Next peer range.

## Doc URLs
- https://www.assistant-ui.com/llms.txt - index (append `.md` to any docs URL)
- https://www.assistant-ui.com/docs/installation.md , https://www.assistant-ui.com/docs/cli.md
- https://www.assistant-ui.com/docs/runtimes/pick-a-runtime.md , .../runtimes/ai-sdk/v7.md
- https://www.assistant-ui.com/docs/integrations/frameworks/mastra/overview.md (full-stack + separate-server guides linked)
- https://www.assistant-ui.com/docs/runtimes/custom/local-runtime.md , .../custom/external-store.md
- https://www.assistant-ui.com/docs/tools.md , .../api-reference/tools/tool-ui.md
- https://www.assistant-ui.com/docs/cloud.md , .../cloud/quickstart.md
- https://github.com/assistant-ui/skills (setup/references/mastra.md, tools/references/human-in-loop.md, cloud/SKILL.md)
