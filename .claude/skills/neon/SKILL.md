---
name: neon
description: Use when writing or changing anything that touches the Neon Postgres database in "Do It Once" - SQL schema/migrations, @neondatabase/serverless queries in Next.js route handlers or Mastra tools, pgvector embeddings for skill_triggers semantic retrieval, Mastra @mastra/pg storage, Neon branches for safe testing, the neon/neonctl CLI, or the Neon AI Gateway (LLM + embeddings).
---

# Neon (serverless Postgres) - "Do It Once" project skill

Docs checked: **2026-10-04**. Neon now brands its database as "Lakebase Postgres on Neon" (Databricks); same product and APIs.
Official agent skills exist and this file is based on them: https://github.com/neondatabase/agent-skills
(`skills/neon`, `neon-postgres`, `neon-postgres-branches`, `neon-ai-gateway`, ...). Install the full set with
`npx skills add neondatabase/agent-skills` or in Claude Code `/plugin marketplace add neondatabase/agent-skills`.
Items marked **[UNVERIFIED]** were not confirmed against a primary doc page or conflicted between sources.

Env vars: `DATABASE_URL` (pooled, host contains `-pooler`), optional `DATABASE_URL_UNPOOLED` (direct, for migrations),
`NEON_API_KEY` (CLI/API), and if the AI Gateway is used `NEON_AI_GATEWAY_TOKEN` + `NEON_AI_GATEWAY_BASE_URL`.

## 1. Connection rules

| Use case | Connection string |
| --- | --- |
| Route handlers, Mastra tools, `@mastra/pg` | Pooled (`-pooler` host) |
| Migrations, `pg_dump`, LISTEN/NOTIFY, session `SET` | Direct (no `-pooler`) |

Running migrations over the pooled URL can fail with errors like `prepared statement already exists`.
Get both URLs with `neon env pull` or `neon connection-string`.

## 2. @neondatabase/serverless v1 (repo uses ^1.2.0, requires Node >= 19)

```ts
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);          // HTTP, one round trip per query, no connection to manage

// Tagged template: values are sent as bind parameters (injection-safe)
const rows = await sql`SELECT * FROM personal_skills WHERE user_id = ${userId} AND status = ${'active'}`;
```

**v1 breaking change:** the function returned by `neon()` is tagged-template only. Calling it as
`sql('SELECT ... $1', [x])` throws. For dynamic SQL text use `sql.query`:

```ts
const rows = await sql.query('SELECT * FROM skill_runs WHERE skill_id = $1 ORDER BY started_at DESC LIMIT $2', [skillId, 20]);

// Trusted identifiers only (never user input):
const col = sortByRecent ? 'created_at' : 'name';
await sql`SELECT * FROM personal_skills ORDER BY ${sql.unsafe(col)} DESC`;
```

Options: `neon(url, { fullResults: true })` returns `{ rows, fields, rowCount, command }`; `{ arrayMode: true }` returns arrays.
Max request/response size over HTTP: 64 MB. Add retry logic for transient network errors.

### Non-interactive transactions (HTTP, single round trip)

```ts
const [run, _ev] = await sql.transaction((tx) => [
  tx`INSERT INTO skill_runs (id, skill_id, user_id, status) VALUES (${runId}, ${skillId}, ${userId}, 'running') RETURNING *`,
  tx`INSERT INTO execution_events (run_id, kind, payload) VALUES (${runId}, 'run_started', ${JSON.stringify(meta)})`,
], { isolationLevel: 'ReadCommitted' });   // also: readOnly, deferrable (needs readOnly + Serializable)
```
All queries are fixed up front: you cannot use the result of query 1 inside query 2. Per-query options are not allowed inside a transaction.

### Interactive transactions: Pool / Client over WebSockets

```ts
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
neonConfig.webSocketConstructor = ws;   // Node only; Node 22+ has global WebSocket [UNVERIFIED that ws is optional there]

export async function POST(req: Request) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [skill] } = await client.query('INSERT INTO personal_skills (user_id, name) VALUES ($1, $2) RETURNING id', [uid, name]);
    await client.query('INSERT INTO skill_steps (skill_id, position, action) VALUES ($1, 1, $2)', [skill.id, action]);
    await client.query('COMMIT');
    return Response.json(skill);
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); await pool.end(); }
}
```
**Gotcha:** in serverless/edge, a WebSocket Pool/Client must be created, used and closed inside one request. Do not keep a module-level Pool there.
Note: the official `neon-postgres` skill recommends plain `pg` (node-postgres) on Vercel Fluid compute / long-lived Node servers (our Fly.io server), and `@neondatabase/serverless` for serverless/edge.

### Next.js App Router route handler

```ts
// app/api/skills/route.ts
import { neon } from '@neondatabase/serverless';
export const runtime = 'nodejs';          // 'edge' also works with the HTTP driver
const sql = neon(process.env.DATABASE_URL!);   // module-level neon() is fine: it is stateless HTTP

export async function GET(req: Request) {
  const userId = new URL(req.url).searchParams.get('userId');
  const skills = await sql`SELECT id, name, description FROM personal_skills WHERE user_id = ${userId}`;
  return Response.json(skills);
}
```

## 3. pgvector for skill_triggers (semantic trigger matching)

Docs: https://neon.com/docs/extensions/pgvector . Neon supports the current pgvector release plus one prior.
Indexable dimension limits: `vector` <= 2000, `halfvec` <= 4000, `bit` <= 64000, `sparsevec` <= 1000 non-zero.
Dimension must match the embedding model exactly. Recommendation for this project:
- Neon AI Gateway `qwen3-embedding-0-6b` -> `vector(1024)` (see section 5), or
- OpenAI `text-embedding-3-small` -> `vector(1536)` (its default; can be shortened via the `dimensions` param).
Pick one model and never mix models in one column.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS skill_triggers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id    uuid NOT NULL REFERENCES personal_skills(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phrase      text NOT NULL,                 -- "Cancel subscription", "stop paying for this"
  embedding   vector(1024) NOT NULL,
  embed_model text NOT NULL DEFAULT 'qwen3-embedding-0-6b',
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- Cosine distance needs the cosine opclass; defaults m=16, ef_construction=64
CREATE INDEX IF NOT EXISTS skill_triggers_embedding_hnsw
  ON skill_triggers USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS skill_triggers_user_idx ON skill_triggers (user_id);
```

Operators: `<=>` cosine distance, `<->` L2, `<#>` negative inner product, `<+>` L1. Similarity = `1 - (a <=> b)`.

```ts
// Pass the vector as a pgvector text literal '[0.1,0.2,...]' and cast
const vec = JSON.stringify(embedding);                  // number[] -> "[...]"
const matches = await sql`
  SELECT t.skill_id, s.name, t.phrase, 1 - (t.embedding <=> ${vec}::vector) AS similarity
  FROM skill_triggers t JOIN personal_skills s ON s.id = t.skill_id
  WHERE t.user_id = ${userId}
  ORDER BY t.embedding <=> ${vec}::vector
  LIMIT 5`;
const best = matches[0]?.similarity >= 0.75 ? matches[0] : null;   // threshold: tune on real phrases [UNVERIFIED value]
```
Gotchas: the `ORDER BY` must use the same operator as the index opclass or the HNSW index is skipped.
With a `WHERE user_id = ...` filter, HNSW filters after the scan and can return fewer than LIMIT rows;
for small per-user sets (hackathon scale) that is fine, otherwise raise `SET hnsw.ef_search = 100` (needs the
WebSocket client or a transaction, since each HTTP query is its own session) or enable `hnsw.iterative_scan` [UNVERIFIED on Neon version].
For big index builds: `SET maintenance_work_mem` (<= 50-60% of compute RAM).

## 4. Rest of the schema (indexes worth having)

```sql
CREATE INDEX ON personal_skills (user_id);
CREATE INDEX ON skill_steps (skill_id, position);           -- ordered replay
CREATE INDEX ON skill_preferences (skill_id);
CREATE INDEX ON skill_runs (user_id, started_at DESC);
CREATE INDEX ON skill_runs (skill_id, started_at DESC);
CREATE INDEX ON execution_events (run_id, created_at);      -- timeline per run
CREATE INDEX ON approvals (run_id) WHERE status = 'pending'; -- pending-approval inbox
CREATE INDEX ON artifacts (run_id);
CREATE INDEX ON incoming_triggers (user_id, received_at DESC);
```
Use `jsonb` for step params, event payloads and preferences; `gen_random_uuid()` is built in (PG13+).
Mastra (`@mastra/pg` `PostgresStore`) creates its own `mastra_*` tables (workflow snapshots, threads, messages)
on init; keep app tables free of the `mastra_` prefix and do not hand-migrate those tables.

## 5. Neon AI Gateway (exists; LLMs + embeddings)

Docs: https://neon.com/docs/ai-gateway/overview.md , /get-started.md , /models.md ; agent skill `neon-ai-gateway`.
- One branch-scoped endpoint, powered by Databricks, for Anthropic/OpenAI/Google/Meta/Alibaba models.
- **Requires a paid Neon plan with prepaid credits; Free plan cannot provision it.** Regions: aws-us-east-1, aws-us-east-2, aws-eu-central-1, aws-ap-southeast-1.
- Enable: Console Connect -> AI Gateway tab, or `neon credentials create --scope ai_gateway:invoke`, or `neon config add ai-gateway` + `neon deploy`.
- Env: `NEON_AI_GATEWAY_TOKEN=nt_live_...`, `NEON_AI_GATEWAY_BASE_URL=https://br-<name>-api.ai.<cell>.<region>.aws.neon.tech` (no path).
- Dialects: OpenAI Chat Completions `/v1`, OpenAI Responses `/openai/v1`, Anthropic Messages `/anthropic`, Gemini `/gemini`; `GET /v1/models` lists models. Auth: `Authorization: Bearer $NEON_AI_GATEWAY_TOKEN`.
- Embeddings: `POST /v1/embeddings` with `qwen3-embedding-0-6b` (1024 dims, $0.02/M tok) or `gte-large-en` (1024 dims, $0.13/M tok).
- Chat model IDs have no provider prefix: e.g. `gpt-5-mini`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `gemini-3-flash`. Canonical list: https://models.dev/providers/neon
- Mastra >= 1.47 (repo has ^1.74): `model: 'neon/claude-haiku-4-5'` reads the `NEON_AI_GATEWAY_*` env vars. Vercel AI SDK: `@neon/ai-sdk-provider`.
- Soft limit 200k tokens/min per account plus a daily spend cap. **[UNVERIFIED]** status: the models page says "inference is free during the private preview" while get-started reads as GA; confirm in the console.

```ts
import OpenAI from 'openai';
const ai = new OpenAI({ apiKey: process.env.NEON_AI_GATEWAY_TOKEN, baseURL: `${process.env.NEON_AI_GATEWAY_BASE_URL}/v1` });
const { data } = await ai.embeddings.create({ model: 'qwen3-embedding-0-6b', input: ['stop paying for this'] });
const embedding = data[0].embedding;   // length 1024 -> vector(1024)
```
If the account is on the Free plan, fall back to another embeddings provider and size the column to it.

## 6. Migrations (hackathon approach: plain SQL + node runner)

`db/migrations/001_init.sql`, `002_...sql`; run against the **direct** URL; each file runs once and is recorded.

```ts
// scripts/migrate.mjs  ->  node scripts/migrate.mjs
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL });
const c = await pool.connect();
await c.query('CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
const done = new Set((await c.query('SELECT name FROM _migrations')).rows.map(r => r.name));
for (const f of (await readdir('db/migrations')).filter(f => f.endsWith('.sql')).sort()) {
  if (done.has(f)) continue;
  try {
    await c.query('BEGIN');
    await c.query(await readFile(`db/migrations/${f}`, 'utf8'));   // multi-statement OK on the WebSocket client
    await c.query('INSERT INTO _migrations (name) VALUES ($1)', [f]);
    await c.query('COMMIT'); console.log('applied', f);
  } catch (e) { await c.query('ROLLBACK'); console.error('failed', f, e.message); process.exit(1); }
}
c.release(); await pool.end();
```
Why not the HTTP `neon()` client: it sends one statement per query (no multi-statement files). `CREATE INDEX CONCURRENTLY`
cannot run inside a transaction; put it in its own file without BEGIN if ever needed. The official skill prefers
ORM migrations (Drizzle Kit) for larger projects; plain SQL is fine here.

## 7. Branching and the CLI

CLI: `npm i -g neon` (command `neon`; `neonctl` is an alias). Auth: `neon login`, or `NEON_API_KEY` env / `--api-key`.
[UNVERIFIED: older docs/installs use the npm package `neonctl`; either works.] Docs: https://neon.com/docs/reference/neon-cli

```bash
neon set-context --project-id <project-id>
neon branches create --name test-migrate --parent main --expires-at 2026-10-11T00:00:00Z   # copy-on-write, max TTL 30 days
neon branches create --name ci-schema --parent main --schema-only                         # structure only, no rows
neon connection-string test-migrate          # point DATABASE_URL at it, run migrate, run tests
neon branches reset test-migrate --parent    # discard changes and re-sync from parent
neon branches delete test-migrate
neon inspect db table-sizes                  # also: unused-indexes, seq-scans, long-running-queries, locks
```
Workflow: create a branch per risky migration or demo-data experiment, test there, then run the same SQL file on main.
Branches have separate compute and scale to zero (first query after idle may be slow: cold start).

## 8. Gotchas checklist

- Never call `sql(...)` as a plain function (v1 throws); use the tagged template or `sql.query(text, params)`.
- Never interpolate user input via `sql.unsafe`.
- HTTP `neon()` queries are separate sessions: `SET ...` does not carry to the next query.
- Pool/Client in serverless: open + close per request. On Fly.io (long-lived Node), one shared Pool / `pg` is fine.
- Pooled URL for app traffic; direct URL for migrations/dumps/LISTEN.
- Vector dim must equal model output; pass vectors as `'[..]'::vector`; ORDER BY the indexed operator (`<=>` with `vector_cosine_ops`).
- Do not use `neondb_owner` for JWT/RLS-based access (it bypasses RLS).
- JSR distribution of the driver is deprecated; install from npm.

## Sources (checked 2026-10-04)
- https://github.com/neondatabase/agent-skills (skills: neon, neon-postgres, neon-postgres-branches, neon-ai-gateway)
- https://neon.com/docs/serverless/serverless-driver
- https://neon.com/docs/extensions/pgvector
- https://neon.com/docs/ai-gateway/overview.md , get-started.md , models.md
- https://neon.com/docs/reference/neon-cli
- https://neon.com/docs/connect/choose-connection.md , https://neon.com/docs/introduction/branching.md
