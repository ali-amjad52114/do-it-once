# Demo script: 60-second judging narration

What to say, what to click, what the screen should show, and how long each beat takes. Every beat
runs live on the deployed app, https://neon-agent-ali.fly.dev (demo site:
https://do-it-once-demo.fly.dev). Timings below were measured end to end on the deployed app.

## Before you start (T-5 min)

- Open https://neon-agent-ali.fly.dev in a full-width browser window. The AgentMail webhook
  already points at the Fly app, so no tunnel is needed. (Running locally instead? See the README;
  the laptop and the Fly app share one DB and demo site, so run **only one operator**.)
- Run the [reset checklist](#reset-checklist).
- Have a terminal ready with `npx tsx scripts/agentmail-send-demo.ts` typed but not run.
- Optional: send the email 1 minute early so the card is already there (it is idempotent).

## Beats

| # | Time | Say | Do | Screen shows |
|---|---|---|---|---|
| 1 | 0:00–0:08 | "Everyone has repetitive web chores in their personal life. Cancel a subscription. Return an item. Renew registration. Book the same appointment." | Nothing. Let the home page speak. Scroll a little to **My Skills**. | Hero "Your agent remembers how you handle life." The My Skills grid shows Cancel subscription (learned), Return online order, Book haircut and Renew registration ("Not learned yet"). |
| 2 | 0:08–0:12 | "Today, every time the task happens, we start from zero. With Do It Once, I teach my personal agent once." | Point at the **Cancel subscription** skill card. (Optional: `/teach` shows a recording turned into a skill; **Try it now** replays it: approval about 19 s, success about 8 s later.) | The skill card with its run history. |
| 3 | 0:12–0:20 | "Here's a subscription renewal email." | Run `npx tsx scripts/agentmail-send-demo.ts`. The webhook delivers it to the Fly app and the card appears in about 5 s (Today polls every 5 s). If it doesn't, click **Check inbox**. | Today card: "From your inbox · Lumen+ Billing", **Membership renewal detected**, Lumen+ · $19/month · Renews tomorrow, then **Matching skill: Cancel subscription** and a **Run** button. |
| 4 | 0:20–0:24 | "My agent recognizes that I already have a Cancel Subscription skill." | Click **Run** on the card. Alternative: type **"Get rid of this subscription"** in the chat box. The agent names the skill and asks to go ahead. Reply "yes". The chat's first reply takes about 10–18 s, so **Run** is the faster path. | The run panel scrolls into view. The pill says "Working", the activity checklist is on the left and "Live browser" on the right. |
| 5 | 0:24–0:40 | "It opens the website, follows what worked last time, and stops only when it reaches an irreversible action." | Nothing. Let the Kernel live view play (read-only iframe). | The live view clicks Billing → Manage membership → Cancel membership → "No thanks, continue to cancel" while checklist lines tick off. About 18–31 s after Run an orange card appears: **"Cancel $19/month membership?"** with Merchant, Price and Renewal read from the page, plus **Approve cancellation** and **Stop**. The pill says "Needs your OK". |
| 6 | 0:40–0:46 | "I approve it. Done." | Click **Approve cancellation**. | About 10 s later it is done. The pill changes to "Finishing up", then "Double-checking". Then a big **CANCELED** with "$228/year no longer recurring", "What your agent did" and the proof panel: matched evidence ("Membership canceled"), final URL, screenshot and timestamp. The Today card shows **Handled**. |
| 7 | 0:46–0:50 | "Next month, I don't need to remember how this website works." | Scroll to the proof panel or open the skill page (`/skills/<id>`). | Success rate and run history update from the real run. |
| 8 | 0:50–0:57 | "And when the website changes, the skill heals itself." | Run the v2 command (below), then click **Run** on the Today card (or use the chat). | Step "Open billing settings" fails, and a "Website changed — healing" timeline appears. Exa runs a real search; on this fictional site it finds nothing published, and the timeline says so honestly ("reading the live page instead"). Approval arrives at about 55 s. The agent clicks **Plan & payments → Manage plan → More options → End membership → Continue to end membership** and stops at the approval card. Click **Approve**; about 12 s later the run is verified as canceled, and the skill page shows **v2**. A second run on v2 needs no heal (approval at about 22 s). |
| 9 | 0:57–1:00 | "Do it once. Your agent does it forever." | Nothing. | The footer tagline. |

Switch to v2 for beat 8 ("the website changes"):

```bash
curl -X POST -H "content-type: application/json" -d '{"layout":"v2"}' https://neon-agent-ali.fly.dev/api/demo/layout
```

**Optional beat (Return, if time allows):** run **Return online order**. Approval at about 30 s,
succeeded about 9 s after Approve, the label lands in the Fly Sprite
(`/home/sprite/workspace/return-labels/…`) about 3.5 s later, and Executor creates a **real**
Google Calendar event about 19 s later. Every Return run creates a new calendar event.

**Honest limits to keep in mind on stage:** the public URL has no auth; the label is fetched
server-side, not as a browser download; the demo websites are fictional by design.

## Where each line comes from (for judges' questions)

| Line | Code |
|---|---|
| renewal email | `scripts/agentmail-send-demo.ts` → `app/api/webhooks/agentmail/route.ts` or `app/api/inbox/sync/route.ts` → `lib/agentmail/ingest.ts` |
| recognizes the skill | `lib/triggers/classify.ts` (`skillQuery`) → `lib/skills/retrieve.ts` (pgvector) |
| opens the website | `lib/mastra/workflows/chore-run.ts` `prepare` → `lib/kernel/adapter.ts` |
| stops at irreversible | `approval` step → `suspend()`; `components/ApprovalCard.tsx` |
| Done | `verifyAndFinish` in `lib/engine/engine.ts`; `components/evidence/ProofPanel.tsx` |
| heals itself | `lib/heal/`, `lib/exa/`, `components/heal/` |
| label and calendar | `lib/actions/` → `lib/fly/workspace.ts`, `lib/executor/` |
| teach | `app/api/teach/recordings/`, `lib/learn/`, `app/(dashboard)/teach/` |

## Screenshots in the README (`docs/screenshots/`)

Captured from the deployed app with a Kernel browser at 1280×800: `today.png` (beat 3),
`live-view.png` (beat 5, activity list and live browser), `approval.png` (beat 5, end),
`canceled.png` (beat 6), `skill.png` (beat 7), `teach.png` (Teach Mode) and `demo-site.png`
(the Lumen+ confirm-cancellation page).

## Reset checklist

Run it before every rehearsal and before judging.

1. `curl -X POST https://neon-agent-ali.fly.dev/api/demo/reset` (or click **Reset demo** in the
   app header). This stops unfinished runs, puts the seeded Today trigger back to pending, resets
   the demo site to active membership on **layout v1**, and dismisses email cards from earlier
   rehearsals. Run history is kept.
2. Before judging, clear the history too: `npm run db:seed -- --wipe`.
3. For the email beat, optionally hide the seeded card so only the email card shows (Neon SQL
   editor): `UPDATE incoming_triggers SET state = 'dismissed' WHERE source = 'seed';`
   **Reset demo** brings it back as a fallback.
4. After a heal rehearsal, put the skill back on v1 with `npm run db:seed`, which upserts the
   seeded v1 steps by fixed ids (`resetSkillToVersion(skillId, 1)` in `lib/heal/versions.ts`, as
   used by `scripts/smoke-heal.ts`, also drops the newer versions).
5. Reload the home page. Check that no run panel is open and that the Today card shows **Run**.
6. Optional: `npx tsx scripts/smoke-kernel.ts` to warm up Kernel. Check that no stray browsers are
   left in the Kernel dashboard.
