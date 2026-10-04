---
name: fly-sprites
description: Use when code in this repo creates, drives, or reads from a Fly.io Sprite (sprites.dev, the persistent Linux "computer" that is the Do It Once agent's workspace for receipts, downloads, return labels, statements, artifacts), when using @fly/sprites / the Sprites REST API / the `sprite` CLI, or when deploying the Next.js app or the demo membership site to Fly.io (flyctl, fly.toml, Dockerfile, fly secrets, GitHub Actions).
---

# Fly.io Sprites + Fly app deploys (Do It Once)

Checked against official docs on **2026-10-04**. `@fly/sprites` latest = **0.2.3** (needs **Node >= 24**).
Items marked **[UNVERIFIED]** were not confirmed in official docs or the SDK source; test before relying on them.

## Official sources (read these first if something looks off)
- Docs index (llms.txt; the Sprites section lives here): https://docs.fly.io/llms.txt
  (docs.sprites.dev redirects to https://docs.fly.io/sprites/). Pages are also served as `.md`, e.g. https://docs.fly.io/sprites/quickstart.md
- Official agent skill (Fly.io, MIT): https://github.com/superfly/skills/tree/main/skills/sprites (SKILL.md and `references/http-api.md`, `files.md`, `services.md`, `checkpoints.md`)
- Official Claude Code plugin (hosted MCP + skills): https://github.com/superfly/sprites-claude-plugin
- JS/TS SDK: https://github.com/superfly/sprites-js (npm `@fly/sprites`); OpenAPI: https://docs.fly.io/sprites/api/openapi.json
- Hosted MCP server (OAuth, for interactive agents, not for our server): `https://sprites.dev/mcp`
- Pricing: https://sprites.dev (pricing section). Tokens: https://sprites.dev/account

This skill adapts the official ones for *server-side TypeScript* (our Next.js/Mastra backend calls Sprites with an org token). For using Sprites interactively from Claude Code, install the official plugin instead.

## Mental model
- A Sprite is a hardware-isolated Ubuntu (25.10) VM: 8 vCPU, platform-managed RAM, **100 GB ext4 disk that persists forever** (until destroyed). Node, Python, Go, git, curl preinstalled. Home is `/home/sprite`.
- **Disk persists, memory does not.** After ~30 s idle it goes `warm` (suspended, wakes in 100-500 ms, processes resume), later `cold` (stopped, wakes in 1-2 s, processes gone). Status enum: `cold | warm | running`.
- Any API call (exec, fs, HTTP to its URL) wakes it automatically. No start/stop calls needed.
- Open TCP connections drop on every pause. Long-lived processes must be **Services** (`sprite-env services create`), never `&`/`nohup`/`tmux`.
- Billing only while active (CPU $0.03825/CPU-hr, RAM $0.021875/GB-hr, hot storage $0.000683/GB-hr; $30 trial credit per user/org). Storage billed for bytes written (TRIM-friendly). Checkpoints count against storage.
- Limits surfaced by the SDK as `APIError.errorCode`: `sprite_creation_rate_limited`, `concurrent_sprite_limit_exceeded` (with `retryAfterSeconds`). Exact numeric limits per plan: **[UNVERIFIED]**.

## Auth and env vars
- Get a token: https://sprites.dev/account (or `sprite org auth`, which logs in via your Fly.io account). Format: `org-slug/org-id/token-id/token-value`. REST: `Authorization: Bearer <token>`, base `https://api.sprites.dev`.
- **Env var name is not standardized across official docs.** SDK README uses `SPRITES_TOKEN`; quickstart uses `SPRITE_TOKEN`; other integrations use `SPRITES_API_TOKEN` / `SPRITES_API_KEY`. The SDK does **not** read env itself; you pass the token. In this repo use **`SPRITES_TOKEN`** (fallback `SPRITE_TOKEN`).
- Optional: `SPRITES_API_URL` (override API base), `SPRITE_ORG` (CLI org override), `SPRITES_CLIENT_SIGNALS=0` (disable SDK telemetry headers).
- Server-only secret. Never `NEXT_PUBLIC_`, never send to the browser, never write it into the Sprite.

## CLI cheatsheet (`sprite`)
Install: macOS/Linux `curl -fsSL https://sprites.dev/install.sh | sh`. Windows: download the zip from https://docs.fly.io/sprites/cli/installation (`sprite-windows-amd64.zip`) and put `sprite.exe` on PATH.
```bash
sprite org auth                         # browser login via Fly.io; CI: sprite auth setup --token "$SPRITES_TOKEN"
sprite create doitonce-ali              # create; `sprite use <name>` to set default for this dir (writes .sprite, do not commit)
sprite list --prefix doitonce-
sprite exec -s doitonce-ali -- bash -lc "ls -la /home/sprite/workspace"
sprite console -s doitonce-ali          # interactive shell
sprite checkpoint create -s doitonce-ali --comment "clean workspace"
sprite checkpoint list -s doitonce-ali  # restore: sprite restore v1  (DESTRUCTIVE: discards later state)
sprite url -s doitonce-ali              # URL + auth mode; `sprite url update --auth public|sprite`
sprite proxy 3000                       # forward a sprite port to localhost
sprite destroy -s doitonce-ali          # IRREVERSIBLE: files, checkpoints, URL all gone
sprite api /v1/sprites -- -s            # signed raw REST call
```

## TypeScript SDK essentials (`npm i @fly/sprites`)
```ts
import { SpritesClient, ExecError, APIError } from '@fly/sprites';
const client = new SpritesClient(token, { timeout: 30_000 });   // baseURL defaults to https://api.sprites.dev
client.sprite(name)                     // local handle, no network call
await client.getSprite(name)            // GET; throws APIError on 4xx
await client.createSprite(name, { urlSettings: { auth: 'sprite' }, labels: ['doitonce'] })
await client.listAllSprites('doitonce-'); await client.deleteSprite(name)
// exec (WebSocket). Resolves {stdout, stderr, exitCode}; THROWS ExecError on non-zero exit.
await sprite.execFile('bash', ['-lc', 'pdftotext a.pdf -'], { cwd, env, timeout: 60_000 })
const cmd = sprite.spawn('bash', ['-lc', script]); cmd.stdout.on('data', ...); await cmd.wait()  // streaming
// filesystem (HTTP). Node-fs-like; paths resolve against workingDir (default '/').
const fs = sprite.filesystem('/');      // readFile, writeFile, readdir, mkdir, rm, stat, exists, rename, copyFile, readJSON, writeJSON, watch
// checkpoints: createCheckpoint(comment) / restoreCheckpoint(id) return NDJSON streams -> iterate to the 'complete' event
// services: createService(name, { cmd, args, env, dir, needs, httpPort })  (SDK camelCase; REST body uses http_port)
```
Gotchas:
- **`sprite.exec('a b c')` does NOT use a shell**: it splits on whitespace and runs `a` with args. Quotes, pipes, `&&`, globs, `>` all break. Use `execFile('bash', ['-lc', script])`.
- `execFileHTTP` exists (no WebSocket) but the SDK README warns its framing is unreliable for large output. Prefer `exec`/`execFile`/`spawn`.
- SDK `writeFile` sends `mkdirParents=true`, so parent dirs are created. (The OpenAPI page names this query param `mkdir`; the SDK/official skill use `mkdirParents`. Use the SDK.)
- Next.js: call the SDK only from Node runtime route handlers / server actions (`export const runtime = 'nodejs'`), never Edge or client components. It uses WebSockets and Node streams.
- After `restoreCheckpoint`, the env restarts and sessions die; the next exec retries automatically.
- Restricted MCP/OAuth tokens may require a name prefix (`mcp-`). Org tokens from sprites.dev/account do not **[UNVERIFIED for every token type]**.

## REST equivalents (when not using the SDK)
`POST /v1/sprites` `{name, url_settings:{auth}}` | `GET/PUT/DELETE /v1/sprites/{name}` | `GET /v1/sprites?prefix=`
`POST /v1/sprites/{name}/exec?cmd=bash&cmd=-lc&cmd=<script>&dir=&env=K=V` (response is framed binary: `0x01` stdout, `0x02` stderr, `0x03`+exit byte) | `WSS /v1/sprites/{name}/exec` for streaming/TTY
`GET /v1/sprites/{name}/fs/read?path=&workingDir=` (raw bytes) | `PUT .../fs/write?path=&workingDir=&mkdirParents=true` (raw body) | `GET .../fs/list?path=&workingDir=` -> `{path, count, entries:[{name,path,type,size,mode,modTime,isDir}]}` | `DELETE .../fs/delete`
`POST .../checkpoint` `{comment}` (NDJSON) | `GET .../checkpoints` | `POST .../checkpoints/{id}/restore`
`PUT .../services/{svc}` `{cmd, args[], env{}, dir, needs[], http_port}` | `GET .../services/{svc}/logs`

## Minimal adapter for this repo (`src/lib/sprite.ts`)
```ts
import 'server-only';
import { SpritesClient, ExecError, APIError, type Sprite } from '@fly/sprites';

const token = process.env.SPRITES_TOKEN ?? process.env.SPRITE_TOKEN;
if (!token) throw new Error('SPRITES_TOKEN is not set');
const client = new SpritesClient(token);

// Default user's home is writable; /workspace at filesystem root may need sudo [UNVERIFIED].
export const WORKSPACE = process.env.SPRITE_WORKSPACE ?? '/home/sprite/workspace';
export const DIRS = ['receipts', 'downloads', 'return-labels', 'statements', 'artifacts'] as const;

export async function ensureSprite(name: string): Promise<Sprite> {
  let sprite: Sprite;
  try {
    sprite = await client.getSprite(name);
  } catch (err) {
    if (!(err instanceof APIError && err.statusCode === 404)) throw err;
    sprite = await client.createSprite(name, { urlSettings: { auth: 'sprite' }, labels: ['doitonce'] });
  }
  await exec(sprite, `mkdir -p ${DIRS.map((d) => `${WORKSPACE}/${d}`).join(' ')}`);
  return sprite;
}

export async function exec(sprite: Sprite, script: string, timeoutMs = 120_000) {
  try {
    const r = await sprite.execFile('bash', ['-lc', script], { cwd: WORKSPACE, timeout: timeoutMs });
    return { stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode };
  } catch (err) {
    if (err instanceof ExecError) return { stdout: String(err.stdout), stderr: String(err.stderr), exitCode: err.exitCode };
    throw err;
  }
}

export const writeFile = (s: Sprite, path: string, data: Buffer | Uint8Array | string) =>
  s.filesystem('/').writeFile(path, typeof data === 'string' ? data : Buffer.from(data));

export const readFile = (s: Sprite, path: string): Promise<Buffer> => s.filesystem('/').readFile(path, null);

export async function listFiles(s: Sprite, dir: string) {
  const entries = await s.filesystem('/').readdir(dir, { withFileTypes: true });
  return entries.map((e) => ({ name: e.name, path: `${dir}/${e.name}`, isDir: e.isDirectory() }));
}
```
Usage notes for Do It Once:
- One Sprite per user, deterministic name (e.g. `doitonce-${userId}`; lowercase, DNS-safe). Store the name in Neon.
- Kernel downloads -> Next.js gets the bytes -> `writeFile(sprite, `${WORKSPACE}/receipts/<date>-<vendor>.pdf`, buf)`.
- Text extraction: check tools first (`which pdftotext tesseract`). If missing, `sudo apt-get install -y poppler-utils` once; it persists. Passwordless sudo: **[UNVERIFIED]**, but the official docs use `sudo apt install` inside Sprites.
- Checkpoint after provisioning (`createCheckpoint('provisioned')`) so a bad agent run can be rolled back. Ask the user before any restore.
- Shell-quote any user/agent-supplied path before putting it in a `bash -lc` script, or pass values via `env` instead of string interpolation.
- Serving files over the Sprite URL: run a Service with `httpPort` (default route is port 8080). URL is private (`auth: sprite`, needs `Authorization: Bearer <token>`) by default. Do not make it public unless it serves nothing sensitive; prefer streaming files through our Next.js API instead.

## Fly.io app deploys (web app + demo membership site)
Current repo state: `fly.toml` app `neon-agent-ali`, region `iad`, `[http_service] internal_port = 8080`, `force_https`, `auto_stop_machines = 'stop'`, `min_machines_running = 0`, 1 GB shared VM. `Dockerfile` is `node:24-slim`, `npm ci --omit=dev`, `CMD node server.mjs`. `.github/workflows/fly-deploy.yml` runs `flyctl deploy --remote-only` on push to `main` with `FLY_API_TOKEN` secret.

For Next.js, set `output: 'standalone'` in `next.config.ts` and use a multi-stage Dockerfile (official Fly guide: https://docs.fly.io/js/frameworks/nextjs.md):
```dockerfile
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone /app
COPY --from=build /app/.next/static /app/.next/static
COPY --from=build /app/public /app/public
EXPOSE 8080
CMD ["node", "server.js"]
```
- `internal_port` in fly.toml must equal the port the server listens on (8080 here). `HOSTNAME=0.0.0.0` is required or the standalone server binds to localhost only.
- Runtime secrets: `fly secrets set SPRITES_TOKEN=... DATABASE_URL=... KERNEL_API_KEY=... -a neon-agent-ali` (restarts machines; `--stage` + `fly secrets deploy` to defer). `fly secrets list` shows names only.
- `NEXT_PUBLIC_*` values are inlined at **build** time, so `fly secrets` does not reach them. Use `[build.args]` in fly.toml or build secrets (https://docs.fly.io/apps/build-secrets.md).
- CI token: `fly tokens create deploy -a <app>` -> GitHub secret `FLY_API_TOKEN`.
- Demo membership site: separate Fly app with its own config, e.g. `demo-site/fly.toml`; `fly launch --no-deploy` inside that dir, then `fly deploy -c demo-site/fly.toml`. It must be publicly reachable (`https://<app>.fly.dev`) because Kernel's cloud browser loads it. Set `min_machines_running = 1` (or `auto_stop_machines = 'off'`) for demo day so Kernel never hits a cold start.
- Debug: `fly logs -a <app>`, `fly status`, `fly ssh console`, `fly releases`.

## Open questions / verify before demo
- Whether `/workspace` (root-level) is writable without sudo; adapter defaults to `/home/sprite/workspace`.
- `pdftotext` / `tesseract` presence in the base image.
- Concurrent-sprite and creation-rate limits for our plan.
- `getSprite` on a missing name is expected to throw `APIError` with `statusCode 404` (SDK source parses all >= 400 into `APIError`); confirm once live.
