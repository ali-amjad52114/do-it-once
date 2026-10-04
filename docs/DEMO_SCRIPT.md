# Demo script: 60-second judging narration

What to say, what to click, what the screen should show, and how long each beat takes. Beats
marked **(landing in Wave B)** depend on Wave B work. Use the fallback line until that work merges.

## Before you start (T-5 min)

- `node demo-site/server.mjs` and `cloudflared tunnel --url http://localhost:4000` are running.
  `DEMO_SITE_URL` in `.env` matches the tunnel, and `npm run db:seed` has been run since the tunnel changed.
- `npm run dev` is running. Open http://localhost:3000 in a full-width browser window.
- Run the [reset checklist](#reset-checklist).
- Have a terminal ready with `npx tsx scripts/agentmail-send-demo.ts` typed but not run.
- Optional: send the email 1 minute early so the card is already there (it is idempotent).

## Beats

| # | Time | Say | Do | Screen shows |
|---|---|---|---|---|
| 1 | 0:00–0:08 | "Everyone has repetitive web chores in their personal life. Cancel a subscription. Return an item. Renew registration. Book the same appointment." | Nothing. Let the home page speak. Scroll a little to **My Skills**. | Hero "Your agent remembers how you handle life." The My Skills grid shows Cancel subscription (learned), Return online order, Book haircut and Renew registration ("Not learned yet"). |
| 2 | 0:08–0:12 | "Today, every time the task happens, we start from zero. With Do It Once, I teach my personal agent once." | Point at the **Cancel subscription** skill card. (Teach Mode ingest from the extension is **(landing in Wave B)**. Don't demo it live.) | The skill card with its run history. |
| 3 | 0:12–0:20 | "Here's a subscription renewal email." | Run `npx tsx scripts/agentmail-send-demo.ts`. With a webhook (`PUBLIC_APP_URL`), the card appears on its own because Today polls every 5 s. Without one, click **Check inbox**. | Today card: "From your inbox · Lumen+ Billing", **Membership renewal detected**, Lumen+ · $19/month · Renews tomorrow, then **Matching skill: Cancel subscription** and a **Run** button. |
| 4 | 0:20–0:24 | "My agent recognizes that I already have a Cancel Subscription skill." | Click **Run** on the card. Alternative: type **"Get rid of this subscription"** in the chat box. The agent names the skill and asks to go ahead. Reply "yes". | The run panel scrolls into view. The pill says "Working", the activity checklist is on the left and "Live browser" on the right. |
| 5 | 0:24–0:40 | "It opens the website, follows what worked last time, and stops only when it reaches an irreversible action." | Nothing. Let the Kernel live view play (read-only iframe). | The live view clicks Billing → Manage membership → Cancel membership → "No thanks, continue to cancel" while checklist lines tick off. At about 16 s an orange card appears: **"Cancel $19/month membership?"** with Merchant, Price and Renewal read from the page, plus **Approve cancellation** and **Stop**. The pill says "Needs your OK". |
| 6 | 0:40–0:46 | "I approve it. Done." | Click **Approve cancellation**. | The pill changes to "Finishing up", then "Double-checking". Then a big **CANCELED** with "$228/year no longer recurring", "What your agent did" and the proof panel: matched evidence ("Membership canceled"), final URL, screenshot and timestamp. The Today card shows **Handled**. |
| 7 | 0:46–0:50 | "Next month, I don't need to remember how this website works." | Scroll to the proof panel or open the skill page (`/skills/<id>`). | Success rate and run history update from the real run. |
| 8 | 0:50–0:57 | "And when the website changes, the skill heals itself." **(landing in Wave B)** | Run the v2 command (below). In the chat, type **"Get rid of this subscription"**, then "yes". | **(landing in Wave B)** Step "Open billing settings" fails, and a "Website changed — healing" timeline appears with Exa sources. The agent clicks **Plan & payments → Manage plan → More options → End membership → Continue to end membership** and stops at the approval card. Click **Approve**. The run is verified as canceled, and the skill page shows **v2**. |
| 9 | 0:57–1:00 | "Do it once. Your agent does it forever." | Nothing. | The footer tagline. |

Switch to v2 for beat 8. This makes the membership active again and changes the layout in one call:

```bash
curl -X POST -H "x-reset-token: $DEMO_RESET_TOKEN" -H "content-type: application/json" \
  -d '{"layout":"v2"}' "$DEMO_SITE_URL/api/reset"
```

**Fallback for beat 8 until Wave B merges:** don't rerun live. Say the line over a still of v2
(`$DEMO_SITE_URL/account?layout=v2` previews it without changing the server). Without heal, a run
on v2 fails at "Open billing settings" with "Your agent couldn't finish · Nothing irreversible was
done." That is safe to show, but it is not the story.

## Where each line comes from (for judges' questions)

| Line | Code |
|---|---|
| renewal email | `scripts/agentmail-send-demo.ts` → `app/api/webhooks/agentmail/route.ts` or `app/api/inbox/sync/route.ts` → `lib/agentmail/ingest.ts` |
| recognizes the skill | `lib/triggers/classify.ts` (`skillQuery`) → `lib/skills/retrieve.ts` (pgvector) |
| opens the website | `lib/mastra/workflows/chore-run.ts` `prepare` → `lib/kernel/adapter.ts` |
| stops at irreversible | `approval` step → `suspend()`; `components/ApprovalCard.tsx` |
| Done | `verifyAndFinish` in `lib/engine/engine.ts`; `components/evidence/ProofPanel.tsx` |
| heals itself | `lib/heal/` **(landing in Wave B)** |

## Screenshots to capture for the README (`docs/screenshots/`)

`today.png` (beat 3), `chat.png` (beat 4, chat variant), `live-view.png` (beat 5, mid-run),
`approval.png` (beat 5, end), `canceled.png` (beat 6), `heal.png` and `skill-v2.png` (beat 8).

## Reset checklist

Run it before every rehearsal and before judging.

1. Demo site back to v1 and active:
   `curl -X POST -H "x-reset-token: $DEMO_RESET_TOKEN" -H "content-type: application/json" -d '{"layout":"v1"}' "$DEMO_SITE_URL/api/reset"`.
   The app's **Reset demo** button also resets the site, but it **keeps the current layout**.
2. Click **Reset demo** in the app header (or run `npm run db:seed -- --reset`). This stops
   unfinished runs and puts the seeded Today trigger back to pending. Run history is kept. Use
   `npm run db:seed -- --wipe` to clear the history too.
3. Clear email cards from earlier rehearsals. A handled card stays visible for 24 h. Run this in
   the Neon SQL editor:
   `UPDATE incoming_triggers SET state = 'dismissed' WHERE source = 'email';`
   For the email beat, optionally hide the seeded card as well so only the email card shows:
   `UPDATE incoming_triggers SET state = 'dismissed' WHERE source = 'seed';`
   **Reset demo** brings it back as a fallback.
4. After a heal rehearsal, restore the v1 steps with `npm run db:seed`, which upserts the
   seeded steps by fixed ids. Resetting the version history: **(landing in Wave B)**.
5. Reload the home page. Check that no run panel is open and that the Today card shows **Run**.
6. Optional: `npx tsx scripts/smoke-kernel.ts` to warm up Kernel. Check that no stray browsers are
   left in the Kernel dashboard.
