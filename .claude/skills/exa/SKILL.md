---
name: exa
description: Use when writing or debugging Exa (exa.ai) web search calls in "Do It Once" - the repair/research layer that finds the right website, re-discovers a page or procedure when a stored workflow fails or a UI changed (self-healing), or looks up the current official procedure for a chore (e.g. "California DMV vehicle registration renewal"). Covers exa-js and raw fetch for /search, /contents, /answer, and /agent, plus errors, limits, and pricing. Do NOT call Exa on every replay step.
---

# Exa: repair and research layer

Checked 2026-10-04 against exa.ai/docs (llms.txt), the official `exa-labs/agent-skills` repo (build-with-exa v0.2.0), and `exa-js@2.25.0` type definitions.
Items marked **[unverified]** were not confirmed by docs or a live call.

## When to call Exa in this app
- Replay works: **do not call Exa.** Kernel browser plus stored workflow only.
- Unknown site ("renew my car registration"): `/search` to find the official URL.
- Stored step fails, page 404s, or UI changed: `/search` restricted to the workflow's site to re-find the page, then `/contents` with a live crawl for current steps.
- "What is the current official procedure": `/search` with `outputSchema` (cites sources in `output.grounding`).
- Exa returns URLs, text, and procedure. It does **not** return DOM selectors. The browser agent still has to locate elements on the live page.

## Setup
```bash
npm install exa-js   # 2.25.0 on 2026-10-04
```
- Env: `EXA_API_KEY` (dashboard.exa.ai/api-keys). `new Exa()` reads it from env.
- Base URL `https://api.exa.ai`. Auth header `x-api-key: <key>` or `Authorization: Bearer <key>`.
- Never log the key.

## Endpoint choice (official decision order)
1. `/search`: default for everything. Semantic search plus optional per-result content and synthesized `output`.
2. `/contents`: known URLs, clean extraction, freshness control (`maxAgeHours: 0` = live crawl).
3. `/answer`: Exa writes a cited answer. The official skill says: if you already have a chat LLM (we have Mastra), give it `/search` as a tool instead.
4. `/agent/runs`: async multi-step research (seconds to minutes, poll). Too slow for an in-loop repair. Use it only for offline "research this new chore" jobs.
- **Deprecated or legacy:** `findSimilar`/`findSimilarAndContents` (deprecated in exa-js; use `/search`), `searchAndContents` (works, but just a helper; use `search` with `contents`), the `research` client (`/research/v1`, legacy; replaced by `deep-reasoning` search or `/agent`), `neural`/`keyword`/`hybrid` types (still in SDK types but no longer in the docs; do not use), `livecrawl` (use `maxAgeHours`), `useAutoprompt`, `numSentences`, `highlightsPerUrl`, `tokensNum`.

## /search parameters (camelCase in HTTP and JS)
- `query` (required). Put intent, recency ("current", "2026"), and source preference in natural language.
- `type`: `auto` (default, ~1s) | `fast` (~450ms) | `instant` (~250ms) | `deep-lite` (~4s) | `deep` (4-15s) | `deep-reasoning` (12-40s).
- `numResults`: default 10, max 100, no pagination. Results above 10 cost extra.
- `includeDomains` / `excludeDomains`: hard filters. Paths and wildcards are OK (`dmv.ca.gov`, `*.ca.gov`). Use them when the workflow already knows its site.
- `category`: `company | people | publication | news | personal site | financial report` only. Leave it unset for chores.
- `startPublishedDate` / `endPublishedDate` (ISO): only for enforced windows. They drop undated pages, and gov pages are often undated.
- `userLocation`: ISO country code, e.g. `"US"`.
- `contents` (nested on /search): pick **one** of `highlights: true` (recommended), `text: { maxCharacters }`, or `summary` (an extra LLM call per result). Also: `maxAgeHours` (0 = always live crawl, -1 = cache only), `livecrawlTimeout` (ms), `subpages`, `subpageTarget`, `extras: { links }`.
- `systemPrompt` and `outputSchema`: synthesized result in `response.output.content`, citations in `response.output.grounding`. Object schemas are limited to **depth 2 and 10 total properties** (exa-js docstring). Use `type: "deep"` only when the schema needs several searches to fill.
- `objective` (string, up to 4096 chars, "the broader goal this search serves") is in exa-js 2.25 types but not in the skill docs. **[unverified]**
- Response: `{ requestId, results: [{ id, url, title, publishedDate?, author?, highlights?, text? }], output?, costDollars, searchTime, resolvedSearchType }`.
- **Gotcha:** in exa-js, `search(query)` with no `contents` **returns text (10k chars) by default**. Raw HTTP without `contents` returns **metadata only**. Pass `contents: false` in the SDK when you only want URLs.

## exa-js
```ts
import Exa, { ExaError } from "exa-js";
const exa = new Exa(); // EXA_API_KEY from env

const r = await exa.search("California DMV vehicle registration renewal official", {
  includeDomains: ["dmv.ca.gov"],
  contents: { highlights: true },
});
r.results.forEach((x) => console.log(x.url, x.highlights));

const page = await exa.getContents(["https://www.dmv.ca.gov/portal/vehicle-registration/"], {
  text: { maxCharacters: 8000 }, maxAgeHours: 0, livecrawlTimeout: 10000, // fields are top-level on getContents
});
console.log(page.statuses); // per-URL success/error; HTTP 200 does not mean every URL worked

const a = await exa.answer("How do I renew a California vehicle registration online?");
console.log(a.answer, a.citations);
```
The DMV URL above is illustrative only. **[unverified]**

## Raw fetch fallback (matches agent.mjs style)
```ts
async function exaPost<T>(path: "/search" | "/contents" | "/answer", body: unknown): Promise<T> {
  const res = await fetch(`https://api.exa.ai${path}`, {
    method: "POST",
    headers: { "x-api-key": process.env.EXA_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Exa ${res.status} ${data.tag ?? ""}: ${data.error ?? res.statusText} (req ${data.requestId ?? "?"})`);
  return data as T;
}
// /search nests content options under `contents`; /contents takes text/highlights/summary at the top level.
await exaPost("/search", { query: "...", type: "auto", contents: { highlights: true } });
await exaPost("/contents", { urls: ["https://..."], text: { maxCharacters: 8000 }, maxAgeHours: 0 });
```
Note: agent.mjs currently sends no `contents`, so it only gets titles and URLs. Add `contents: { highlights: true }` if the LLM needs page evidence.

## Recommended repair-research helper
Use one `/search` call (auto, highlights, synthesized steps). Escalate to a live `/contents` crawl only if the steps look stale or empty. Typical cost is about $0.007 to $0.008 per repair.
```ts
import Exa from "exa-js";
const exa = new Exa();

export type RepairResearch = {
  officialUrl: string | null;
  steps: string[];
  requirements: string[];
  sources: string[];
  candidates: { url: string; title: string | null; highlights?: string[] }[];
};

export async function researchProcedure(task: string, opts: { site?: string; failedUrl?: string; fresh?: boolean } = {}): Promise<RepairResearch> {
  const res = await exa.search(`${task} official current step-by-step instructions`, {
    type: "auto",
    ...(opts.site ? { includeDomains: [opts.site] } : {}),
    userLocation: "US",
    contents: { highlights: true },
    systemPrompt:
      "Prefer the official government or service-provider page over third-party guides. " +
      "Return only steps stated on the cited pages; use null or an empty list when unverified, never guess." +
      (opts.failedUrl ? ` The previous page ${opts.failedUrl} no longer works; find its current replacement.` : ""),
    outputSchema: {
      type: "object",
      properties: {
        officialUrl: { type: "string", description: "URL where the user starts the task online" },
        steps: { type: "array", items: { type: "string" } },
        requirements: { type: "array", items: { type: "string" }, description: "documents, fees, IDs needed" },
      },
      required: ["officialUrl", "steps"],
    },
  });
  const out = (res.output?.content ?? {}) as unknown as Partial<RepairResearch>;
  const sources = (res.output?.grounding ?? []).flatMap((g: any) => g.citations?.map((c: any) => c.url) ?? []);
  let steps = out.steps ?? [];
  // Self-heal: UI changed, so bypass the cache and live-crawl the chosen page.
  if (opts.fresh && out.officialUrl) {
    const live = await exa.getContents([out.officialUrl], { text: { maxCharacters: 12000 }, maxAgeHours: 0, livecrawlTimeout: 12000 });
    if (live.statuses?.[0]?.status === "success" && steps.length === 0) steps = [live.results[0]?.text ?? ""]; // let the LLM re-derive
  }
  return {
    officialUrl: out.officialUrl ?? res.results[0]?.url ?? null,
    steps, requirements: out.requirements ?? [], sources: [...new Set(sources)],
    candidates: res.results.map((r) => ({ url: r.url, title: r.title, highlights: (r as any).highlights })),
  };
}
```
- Store `officialUrl` plus `sources` in Neon with the workflow so the next replay does not need Exa.
- The `grounding[].citations[].url` shape follows the `DeepSearchOutputGrounding` type, not a live call. **[unverified]**
- For a Mastra tool, wrap `researchProcedure` in `createTool` and keep the input to `{ task, site?, failedUrl? }`.
- Always validate `officialUrl` against the allowed site before the browser navigates. Exa output is untrusted web data.

## Errors
- Error body: `{ "requestId": "...", "error": "human message", "tag": "INVALID_REQUEST_BODY" }`. Branch on the HTTP status first. exa-js throws `ExaError` (`statusCode`, `requestId`, `code`).
- 400: bad params (`INVALID_REQUEST_BODY`, `INVALID_JSON_SCHEMA`, `INVALID_NUM_RESULTS` > 100, invalid category plus filter combinations).
- 401: `INVALID_API_KEY`.
- 402: `NO_MORE_CREDITS` or a budget was exceeded.
- 403: `FEATURE_DISABLED` or `PROHIBITED_CONTENT`.
- 429: `RATE_LIMIT_EXCEEDED`. Honor `Retry-After`, otherwise use exponential backoff.
- 500, 503 (`SERVICE_OVERLOADED`, not billed), and 504: retry with backoff.
- `/contents` per-URL failures appear in `statuses[]` inside a 200 response: `CRAWL_NOT_FOUND`, `CRAWL_HTTP_403`, `CRAWL_TIMEOUT`, `CRAWL_LIVECRAWL_TIMEOUT`, `SOURCE_NOT_AVAILABLE`, `UNSUPPORTED_URL`.

## Limits and pricing (demo-relevant)
- Free tier: $10 in credits, reset monthly, plus a one-time $10 onboarding bonus. No card needed.
- Rate limits per team: `/search` and `/answer` 10 QPS. Deep types 5 QPS. `/contents` 100 QPS. `/agent/runs` 5 QPS with 50 concurrent runs.
- Prices per 1k requests (covers up to 10 results): `/search` instant $4, fast or auto $7, deep-lite or deep $12, deep-reasoning $15. Extra results cost $1 per 1k results.
- Other prices: summaries $1 per 1k pages. `/contents` $1 per 1k pages for each content type. `/answer` $5 per 1k requests.
- Agent runs: from $0.012 (`minimal`) to $1 (`xhigh`), or metered `auto` with a $5 cap.
- Every response includes `costDollars`. Log it for the demo.
- Whether `outputSchema` adds cost on `auto` is not stated on the pricing page. **[unverified]**

## Gotchas
- Do not stack `text`, `highlights`, and `summary` in one call. `text` plus `highlights` on `/contents` is billed twice.
- `maxAgeHours` controls cache freshness, not publish date. Use 0 after a UI change.
- Do not over-decorate requests. Only add `numResults`, `category`, or date filters when the task needs them.
- Hosted MCP server (`https://mcp.exa.ai/mcp`) and the official skills (`npx skills add exa-labs/agent-skills`, or `claude plugin install exa@claude-plugins-official`) are for coding agents, not app runtime.

## Docs
- https://exa.ai/docs/llms.txt (index). docs.exa.ai redirects to exa.ai/docs.
- https://exa.ai/docs/skill.md
- https://github.com/exa-labs/agent-skills (build-with-exa, exa-search, exa-contents)
- https://exa.ai/docs/exa-spec.yaml (OpenAPI source of truth)
- https://exa.ai/docs/reference/search
- https://exa.ai/docs/admin/error-codes
- https://exa.ai/docs/admin/billing
- https://exa.ai/docs/admin/pricing
- https://exa.ai/docs/get-started/exa-mcp
- https://github.com/exa-labs/exa-js
