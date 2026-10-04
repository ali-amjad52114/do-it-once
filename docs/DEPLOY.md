# Deploying Do It Once to Fly.io

The Next.js app runs as Fly app `neon-agent-ali` (region `iad`) at https://neon-agent-ali.fly.dev.
The demo membership site is a separate app (`do-it-once-demo`, `demo-site/fly.toml`); leave it alone.

**Build.** `Dockerfile` is multi-stage on `node:24-slim`: `npm ci`, then `next build --webpack`, then a
runner that only holds `.next/standalone` + `.next/static` (`CMD node server.js`, port 3000). The build
needs no secrets; every key is read at request time.

**Config.** `fly.toml`: `internal_port = 3000`, `force_https`, `auto_stop_machines = 'off'` and
`min_machines_running = 1`, because background runs and SSE streams must not be cut by autostop.
One shared CPU with 1 GB of memory, and a health check on `GET /`.

**Secrets.** They are read from a local `.env` and staged with values sent over stdin, never on argv
or stdout:

    npx tsx scripts/fly-secrets.ts /path/to/.env          # stage; applied on the next deploy
    npx tsx scripts/fly-secrets.ts /path/to/.env --deploy # stage and restart machines now
    flyctl secrets list -a neon-agent-ali                 # names and digests only

The script also sets `PUBLIC_APP_URL=https://neon-agent-ali.fly.dev`. To point the AgentMail webhook
at the deployed app, run `PUBLIC_APP_URL=https://neon-agent-ali.fly.dev npx tsx scripts/agentmail-setup.ts`.
If the script creates a new webhook, the webhook secret rotates: put the new `AGENTMAIL_WEBHOOK_SECRET`
into Fly secrets and `.env`.

**Deploy.** From the repo root, run `flyctl deploy --remote-only --ha=false` (Fly's builder does the
build, and `--ha=false` keeps it to one machine). Pushes to `main` also deploy through
`.github/workflows/fly-deploy.yml`.

**Roll back.** `flyctl releases -a neon-agent-ali --image` lists past images. To roll back, run
`flyctl deploy --image registry.fly.io/neon-agent-ali:<deployment-tag> --ha=false`.
Debug with `flyctl logs -a neon-agent-ali`, `flyctl status -a neon-agent-ali` and `flyctl ssh console -a neon-agent-ali`.
