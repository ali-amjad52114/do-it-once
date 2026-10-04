# Lumen+ demo site

Fictional streaming membership site that the Do It Once agent cancels. Zero dependencies, in-memory state.

- Run: `node demo-site/server.mjs` (port `PORT`, default 4000), then open http://localhost:4000/account
- Test: `node demo-site/test.mjs` walks Account → Billing → Manage membership → Cancel → Confirm, then resets.
- State: `GET /api/state` → `{ status, renewsOn, endsOn, layout }`.
- Reset: `curl -X POST -H "x-reset-token: $DEMO_RESET_TOKEN" http://localhost:4000/api/reset` (check skipped if unset).
- Deploy: `cd demo-site && fly launch --no-deploy` once, `fly secrets set DEMO_RESET_TOKEN=...`,
  then `fly deploy` → https://do-it-once-demo.fly.dev (always on: `min_machines_running = 1`).
- Labels and navigation live in `LAYOUTS` in server.mjs; add a `v2` entry for the `?layout=v2` variant.
