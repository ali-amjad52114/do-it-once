// REAL Discovery race smoke (A4): 3 Kernel agents explore the demo store return flow → judge → winner →
// Teach pipeline → DRAFT skill → one REAL run (waiting_approval → approve → succeeded) → promote → active.
//   npx tsx scripts/smoke-discover.ts
import 'dotenv/config';
import Kernel from '@onkernel/sdk';
import { DEMO_USER_ID, TERMINAL_STATES, type RunState } from '@/lib/contracts';
import { createDiscovery, getDiscoveryView, runDiscovery } from '@/lib/discover/race';
import { getRunEngineWithIdle } from '@/lib/engine';
import { flushTraces } from '@/lib/mastra';
import { getRun, getSkill, listEvents } from '@/lib/neon/repo';
import { promoteTaughtSkill } from '@/lib/learn/store';

const t0 = Date.now();
const since = (t: number) => `${((Date.now() - t) / 1000).toFixed(1)}s`;
const log = (msg: string) => console.log(`[${since(t0)}] ${msg}`);
const GOAL = 'Start a return for my Lumen Aura headphones, refund to my original card, drop off at UPS Store, QR code label';

async function waitForState(runId: string, want: RunState[], timeoutMs: number): Promise<RunState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await getRun(runId);
    if (r && (want.includes(r.state) || TERMINAL_STATES.includes(r.state))) return r.state;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${want.join('/')} (state: ${r?.state})`);
    await new Promise((res) => setTimeout(res, 500));
  }
}

async function resetDemo(demo: string) {
  const headers: Record<string, string> = {};
  if (process.env.DEMO_RESET_TOKEN) headers['x-reset-token'] = process.env.DEMO_RESET_TOKEN;
  const res = await fetch(`${demo}/api/reset`, { method: 'POST', headers });
  if (!res.ok) throw new Error(`demo reset failed: HTTP ${res.status}`);
}

const demoReturns = async (demo: string) =>
  ((await (await fetch(`${demo}/api/state`)).json()) as { returns?: unknown[] }).returns?.length ?? 0;

async function main() {
  const demo = (process.env.DEMO_SITE_URL ?? '').replace(/\/+$/, '');
  if (!demo) throw new Error('DEMO_SITE_URL missing');
  const kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY });
  const before = new Set<string>();
  for await (const b of kernel.browsers.list()) before.add(b.session_id);
  let runId: string | null = null;
  let discoveryId: string | null = null;
  let ok = false;
  try {
    await resetDemo(demo);
    log(`demo reset (${demo}); kernel browsers live before: ${before.size}`);

    // 1. The race.
    const id = await createDiscovery(DEMO_USER_ID, GOAL, `${demo}/store/orders`);
    discoveryId = id;
    log(`discovery ${id}`);
    const tick = setInterval(async () => {
      const v = await getDiscoveryView(id).catch(() => null);
      if (v) log(`  ${v.state}: ${v.attempts.map((a) => `L${a.lane} ${a.state} ${a.steps} steps${a.lastAction ? ` (${a.lastAction})` : ''}`).join(' | ')}`);
    }, 10_000);
    try {
      await runDiscovery(id);
    } finally {
      clearInterval(tick);
    }
    const view = await getDiscoveryView(id);
    if (!view) throw new Error('discovery vanished');
    for (const a of view.attempts) {
      console.log(`  lane ${a.lane} [${a.strategy}] ${a.state} steps=${a.steps} judge=${a.judgment?.verdict ?? '-'} note=${a.note}`);
    }
    const stopped = view.attempts.filter((a) => a.state === 'stopped_at_irreversible');
    const atSubmit = stopped.filter((a) => /submit return/i.test(a.note ?? '') || /submit return/i.test(a.lastAction ?? ''));
    const returnsAfterRace = await demoReturns(demo);
    log(`stopped_at_irreversible=${stopped.length} (at "Submit return": ${atSubmit.length}); demo returns after race=${returnsAfterRace}`);
    log(`state=${view.state} winner=${view.winnerAttemptId} draftSkill=${view.draftSkillId}`);
    if (!atSubmit.length) throw new Error('no attempt stopped at "Submit return"');
    if (returnsAfterRace !== 0) throw new Error('an attempt submitted the return (it must never click "Submit return")');
    if (view.state !== 'done' || !view.draftSkillId) throw new Error('no draft skill saved');

    const skillId = view.draftSkillId;
    const skill = await getSkill(skillId);
    log(`draft skill "${skill?.title}" status=${skill?.status}`);
    for (const s of skill?.steps ?? []) {
      console.log(`  ${s.sequence}. [${s.actionType}] ${s.intent}${s.requiresApproval ? '  ⚠ APPROVAL' : ''} input=${s.inputSource ?? '-'} match=${s.config.matchText ?? '-'}`);
    }
    if (skill?.status !== 'draft') throw new Error('skill is not a draft');

    // 2. One verified REAL run of the draft.
    const engine = getRunEngineWithIdle();
    ({ runId } = await engine.startRun({ skillId, userId: DEMO_USER_ID }));
    log(`started run ${runId}`);
    const s1 = await waitForState(runId, ['waiting_approval'], 240_000);
    await engine.whenIdle(runId);
    if (s1 !== 'waiting_approval') throw new Error(`expected waiting_approval, got ${s1}: ${(await getRun(runId))?.error}`);
    log(`waiting_approval; demo returns=${await demoReturns(demo)}`);
    await engine.approve(runId);
    const s2 = await waitForState(runId, ['succeeded'], 180_000);
    await engine.whenIdle(runId);
    const events = await listEvents(runId);
    console.log(events.map((e) => `  ${String(e.sequence).padStart(2)} ${e.type.padEnd(18)} ${e.message}`).join('\n'));
    const promoted = s2 === 'succeeded' && (await promoteTaughtSkill(runId));
    const after = await getSkill(skillId);
    const returns = await demoReturns(demo);
    log(`after approve: ${s2}; promoted=${promoted}; skill status=${after?.status}; demo returns=${returns}`);
    ok = s2 === 'succeeded' && after?.status === 'active' && returns === 1;
  } finally {
    await flushTraces().catch(() => undefined);
    await resetDemo(demo).catch((e) => log(`reset failed: ${e}`));
    const ours = new Set<string>();
    if (runId) {
      const r = await getRun(runId).catch(() => null);
      if (r?.browserSessionId) ours.add(r.browserSessionId);
    }
    const liveViews = new Set<string>();
    if (discoveryId) for (const a of (await getDiscoveryView(discoveryId).catch(() => null))?.attempts ?? []) if (a.liveViewUrl) liveViews.add(a.liveViewUrl);
    const leaked: string[] = [];
    for await (const b of kernel.browsers.list()) {
      if (ours.has(b.session_id) || (b.browser_live_view_url && liveViews.has(b.browser_live_view_url))) leaked.push(b.session_id);
    }
    for (const x of leaked) await kernel.browsers.deleteByID(x).catch(() => undefined);
    log(`demo reset; kernel browsers we left open: ${leaked.length} (deleted)`);
    if (leaked.length) ok = false;
  }
  log(ok ? 'SMOKE PASSED' : 'SMOKE FAILED');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
