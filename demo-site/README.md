# Lumen+ demo site

Fictional streaming membership site (Lumen+) plus a gear shop (Lumen Store) that the Do It Once agent drives.
Zero dependencies, a single `node:http` process, in-memory state.

- Run: `node demo-site/server.mjs` (port `PORT`, default 4000), then open http://localhost:4000/account
- Tests (each starts its own server on a random port):
  - `node demo-site/test.mjs`: the v1 cancel path that the seeded "Cancel subscription" skill uses
  - `node demo-site/test-v2.mjs`: switches to layout v2, walks the new path, asserts every v1 name is gone
  - `node demo-site/test-store.mjs`: the full Lumen Store return flow, including form posts, QR code and label
- Deploy: `cd demo-site && fly launch --no-deploy` once, `fly secrets set DEMO_RESET_TOKEN=...`,
  then `fly deploy` → https://do-it-once-demo.fly.dev (always on: `min_machines_running = 1`).
- Files: `server.mjs` (pages, `LAYOUTS`, store), `qr.mjs` (dependency-free QR encoder).

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/state` | `{ status, renewsOn, endsOn, layout }`, plus `returns: [...]` **only once a return exists** (keeps the v1 shape identical) |
| POST | `/api/layout` | Body `{"layout":"v1"\|"v2"}` (JSON or form). Header `x-reset-token: $DEMO_RESET_TOKEN` (check skipped if unset). 401 bad token, 400 unknown or missing layout |
| POST | `/api/reset` | Same token rule. Membership back to active, returns cleared. **Keeps the current layout** unless the body has `{"layout":"v1"\|"v2"}` |
| GET | `/healthz` | `{ ok: true }` |
| GET | `any page?layout=v2` | One-off preview of a layout. It does not change the server mode, and links you follow drop the param |

```bash
curl -X POST -H "x-reset-token: $DEMO_RESET_TOKEN" -H "content-type: application/json" \
  -d '{"layout":"v2"}' http://localhost:4000/api/layout     # break the stored path (self-heal demo)
curl -X POST -H "x-reset-token: $DEMO_RESET_TOKEN" -H "content-type: application/json" \
  -d '{"layout":"v1"}' http://localhost:4000/api/reset      # full reset back to v1
```

`returns[]` entries: `{ rma, status:"started", orderId, itemId, item, reasonCode, reason, comments, refund:"original"|"store_credit",
refundLabel, refundAmount, dropOff:"ups_store"|"pickup", dropOffLabel, labelFormat:"qr"|"print", labelFormatLabel,
dropOffBy, pickupOn, labelUrl, createdAt }`.

## Layouts (membership cancel path)

All labels and paths live in `LAYOUTS` in server.mjs. Accessible names are exact and unique per page under
Playwright's case-insensitive substring matching.

| Step | v1 (seeded skill) | v2 (self-heal target) |
|---|---|---|
| 1 navigate | `/account` → "Welcome back, Ali" | same |
| 2 sidebar link | **Billing** → `/account/billing` | **Plan & payments** → `/account/plan` |
| 3 link | **Manage membership** → `/account/membership` | **Manage plan** → `/account/membership` (h1 "Your plan") |
| 4 link | **Cancel membership** (quiet link in "Billing details") → `/account/membership/cancel` | **End membership**, inside a closed `<details>` with summary **More options** (in "Payment details") → `/account/membership/end`. Expand the disclosure first |
| retention h1 | "Before you go…" | "Wait — a better deal for you" |
| 5 link | **No thanks, continue to cancel** → `…/cancel/confirm` | **Continue to end membership** → `/account/membership/end/confirm` |
| confirm h1 | "Confirm cancellation" | "Review and end membership" |
| 6 button | **Confirm cancellation** (POST) | **End my membership** (POST) |
| result | 303 → `/account/membership?canceled=1`: "Membership canceled", "Renews: No", "Access ends on <date>" | same |

Unchanged in both: **Accept offer** (button), **Change plan** (button), **Keep my membership** (link),
**Resume membership** (button), **Update payment method** (button). In v2 the v1 URLs return 404,
and no v1 link or button name (Billing, Manage membership, Cancel membership, No thanks…, Confirm cancellation) appears.

## Lumen Store: return an online item

The header link **Lumen Store** goes to `/store`, whose store nav has **Shop** and **Your orders** (→ `/store/orders`).

| Page | Path | Exact names (role → name) |
|---|---|---|
| Orders | `/store/orders` | 3 orders. Text "Lumen Aura Wireless Headphones · $129.00 · Delivered Sep 28, 2026 · Eligible for return until Oct 28, 2026". Links **Lumen Aura Wireless Headphones**, **View order #LS-20931**, **View order #LS-20877** (gift card, not returnable), **View order #LS-20412** (stream stick, window closed) |
| Order detail | `/store/orders/LS-20931` | link **Return or replace items** |
| 1. Choose items | `/store/orders/LS-20931/return` | checkbox label **Lumen Aura Wireless Headphones**; select label **Reason for return** (options "No longer needed", "Bought by mistake", "Better price available", "Item defective or doesn't work", "Arrived damaged", "Wrong item was sent"); textarea **Comments (optional)**; button **Continue** |
| 2. Refund and drop-off | `…/return/options?…` | fieldset "Refund destination": radios **Original payment method (Visa •••• 4242)**, **Store credit**. Fieldset "Return method": **UPS Store**, **Schedule pickup**. Fieldset "Label format": **QR code**, **Print label**. Nothing preselected. Button **Continue to review** |
| 3. Review | `…/return/review?…` | summary rows (Item, Order, Reason, Refund to, Refund amount, Return method, Label format, Drop off by); button **Submit return** (irreversible, POST `…/return/submit`) |
| Confirmation | `/store/returns/RMA-########` | "Return started", RMA number, "Drop off by <today+14>", inline SVG QR code (`role="img"`, name "Return QR code for RMA-…"), link **Download label** |
| Label | `/store/returns/<rma>/label.svg` | 4×6 SVG label with the QR code, `Content-Disposition: attachment` (`?inline=1` to view) |

Forms are POST + 303 (PRG). Invalid submissions re-render with an error (422). Submitting is idempotent per item.
After a return, the order shows "Return started · RMA-…" and the return URL redirects to the confirmation.

The QR code is real (byte mode, ECC level M, versions 1–10, `qr.mjs`) and encodes `LUMEN-RETURN:<rma>:<orderId>:UPS-STORE|PICKUP`.
It has been verified to decode with OpenCV.
