# Handoff log

## S1 — Foundation + Phase 1 vertical slice (2026-10-04) ✅

**Gate passed.** Today card → Run → real Kernel browser cancels the Lumen+ membership (live view
embedded) → stops at "Cancel $19/month membership?" (price/renewal read from the page) → Approve →
verified on the website (text + URL + screenshot) → "CANCELED · $228/year" → run, 20 events,
approval and screenshot in Neon. Survives a page refresh and a server restart while waiting.

### DONE
- Next.js 16 app, contracts (`lib/contracts.ts`, `docs/CONTRACTS.md`), Neon schema + repo + seed,
  Lumen+ demo site (`demo-site/`), Kernel adapter, run engine, API + SSE, dashboard UI, evidence.
- Verifier V1: 7/7 (3/3 reliability, SSE, stop, fresh-process approve incl. deleted browser, refresh).
- Speed: time-to-approval ~16s (was ~20s). Remaining cost is Kernel CDP round trips per click.
- Fixes from V1: no browser leak when Stop races a reconnect, "Catching up: …" progress events,
  Stop answers instantly, SSE sends events before the state they caused.
- Honest data: no fabricated history. Counts come only from real runs; Return / Haircut /
  Registration are `draft` ("Not learned yet"). `db:seed -- --reset` keeps history,
  `db:seed -- --wipe` clears it.
- Neon AI Gateway works (plan `launch` + credits): chat `claude-haiku-4-5`, embeddings
  `qwen3-embedding-0-6b` (1024 dims). Env: `NEON_AI_GATEWAY_BASE_URL`, `NEON_AI_GATEWAY_TOKEN`.

### How to run
```
node demo-site/server.mjs                        # :4000
cloudflared tunnel --url http://localhost:4000   # copy URL into .env DEMO_SITE_URL
npm run db:seed                                  # refresh start_url for the new tunnel
npm run dev                                      # :3000
```
Restart `next dev` after editing `lib/kernel` or `lib/engine`: both are globalThis singletons, so
hot reload keeps the old instance.

### Sponsors actually in use after S1
Kernel ✅, Neon Postgres ✅, Neon AI Gateway ✅ (tested, not yet called by the app).
Not yet: Mastra, Assistant UI, Exa, AgentMail, Fly Sprites, Executor.

### NEXT (S2)
Mastra workflow with suspend/resume persisted in Neon (`PostgresStore`), Mastra observability,
model calls through Neon AI Gateway (`neon/...`), Assistant UI chat ("Get rid of this subscription").

### Known issues / notes
- `DEMO_SITE_URL` is a temporary trycloudflare tunnel; permanent home is Fly (`demo-site/fly.toml`,
  needs `fly auth login`).
- The migration renamed a pre-existing empty `users` table to `legacy_users` (unrelated old project).
- Semantic threshold: "stop paying for this" vs "Cancel subscription" cosine = 0.553 → tune in S3.
- `docs/ADDONS.md` is untracked and not from this session.
