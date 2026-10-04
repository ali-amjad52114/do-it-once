// REAL end-to-end self-heal smoke (Kernel + Exa + Neon AI Gateway + Neon). Costs a little Kernel time.
//   npx tsx scripts/smoke-heal.ts
// Uses .env (own Neon branch + DEMO_SITE_URL). Phases:
//   setup: skill back to v1, site layout v2
//   A: run → heal events → waiting_approval at "End my membership" → approve → succeeded → skill v2 written
//   B: reset membership (keeps v2) → run → NO heal events → waiting_approval → approve → succeeded
//   finally: no Kernel browser left, layout back to v1, skill back to v1.
import 'dotenv/config';
import Kernel from '@onkernel/sdk';
import { DEMO_USER_ID, TERMINAL_STATES, type RunState } from '@/lib/contracts';
import { getRunEngineWithIdle } from '@/lib/engine';
import { getMastra } from '@/lib/mastra';
import { getLatestApproval, getRun, getSkill, listEvents, resetDemoState } from '@/lib/neon/repo';
import { CANCEL_SKILL_ID } from '@/lib/neon/seed-data';
import { listSkillVersions, resetSkillToVersion } from '@/lib/heal';

const t0 = Date.now();
const secs = (t: number) => `${((Date.now() - t) / 1000).toFixed(1)}s`;
const log = (m: string) => console.log(`[${secs(t0)}] ${m}`);
const demo = (process.env.DEMO_SITE_URL ?? '').replace(/\/$/, '');

async function site(path: string, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.DEMO_RESET_TOKEN) headers['x-reset-token'] = process.env.DEMO_RESET_TOKEN;
  const r = await fetch(`${demo}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
}

async function waitFor(runId: string, want: RunState[], ms: number): Promise<RunState> {
  const end = Date.now() + ms;
  for (;;) {
    const r = await getRun(runId);
    if (r && (want.includes(r.state) || TERMINAL_STATES.includes(r.state))) return r.state;
    if (Date.now() > end) throw new Error(`timeout waiting for ${want} (state ${r?.state})`);
    await new Promise((res) => setTimeout(res, 500));
  }
}

async function phase(name: string, expectHeal: boolean, runIds: string[]): Promise<{ ok: boolean; runId: string }> {
  const engine = getRunEngineWithIdle();
  const tRun = Date.now();
  const { runId } = await engine.startRun({ skillId: CANCEL_SKILL_ID, userId: DEMO_USER_ID });
  runIds.push(runId);
  log(`${name}: run ${runId}`);
  const s1 = await waitFor(runId, ['waiting_approval'], 240_000);
  await engine.whenIdle(runId); // the workflow must have suspended before approve() can resume it
  const tWait = secs(tRun);
  const approval = await getLatestApproval(runId);
  const run = await getRun(runId);
  const skillNow = await getSkill(CANCEL_SKILL_ID);
  log(`${name}: ${s1} after ${tWait}; approval "${approval?.title}" price=${approval?.payload.price} renewal=${approval?.payload.renewal} url=${approval?.payload.pageUrl}`);
  let ok = s1 === 'waiting_approval' && !!approval?.payload.price && !!approval?.payload.renewal;
  if (s1 === 'waiting_approval') {
    const tA = Date.now();
    await engine.approve(runId);
    await engine.whenIdle(runId);
    log(`${name}: approve → finished in ${secs(tA)}`);
  }
  const final = await getRun(runId);
  const events = await listEvents(runId);
  for (const e of events) {
    const dt = ((new Date(e.createdAt).getTime() - new Date(events[0].createdAt).getTime()) / 1000).toFixed(1);
    console.log(`   +${dt.padStart(5)}s ${e.type.padEnd(16)} ${e.message}`);
  }
  const heals = events.filter((e) => e.type.startsWith('heal.'));
  const siteState = (await (await fetch(`${demo}/api/state`)).json()) as { status?: string; layout?: string };
  log(`${name}: state=${final?.state} heal events=${heals.length} site=${siteState.status}/${siteState.layout} total ${secs(tRun)} (currentStep at approval ${run?.currentStep}, skill v${skillNow?.version})`);
  ok = ok && final?.state === 'succeeded' && siteState.status === 'canceled';
  ok = ok && (expectHeal ? heals.some((e) => e.type === 'heal.succeeded') && /End my membership/i.test(JSON.stringify(events)) : heals.length === 0);
  return { ok, runId };
}

async function main() {
  if (!demo) throw new Error('DEMO_SITE_URL missing');
  const kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY! });
  const runIds: string[] = [];
  let ok = false;
  try {
    await resetSkillToVersion(CANCEL_SKILL_ID, 1);
    await resetDemoState();
    await site('/api/reset', { layout: 'v2' });
    log('setup: skill v1, demo site layout v2, membership active');

    const a = await phase('A (v2, heal)', true, runIds);
    const versions = await listSkillVersions(CANCEL_SKILL_ID);
    const skill = await getSkill(CANCEL_SKILL_ID);
    log(`versions: ${versions.map((v) => `v${v.version}(${v.reason}: ${v.note})`).join(' | ')}`);
    for (const s of skill?.steps ?? []) console.log(`   ${s.sequence}. ${s.intent} → ${s.locatorHint} / expect "${s.expectedAfter}"`);
    const v2ok = skill?.version === 2 && versions.some((v) => v.version === 2 && v.reason === 'heal');

    await site('/api/reset', {});
    await resetDemoState();
    log('reset membership (layout stays v2)');
    const b = await phase('B (v2 replay, no heal)', false, runIds);
    ok = a.ok && v2ok && b.ok;
  } finally {
    const ours = new Set<string>();
    for (const id of runIds) {
      const r = await getRun(id).catch(() => null);
      if (r?.browserSessionId) ours.add(r.browserSessionId);
      for (const e of await listEvents(id).catch(() => [])) {
        if (e.type === 'browser.opened' && typeof e.metadata.browserSessionId === 'string') ours.add(e.metadata.browserSessionId);
      }
    }
    const running: string[] = [];
    for await (const b of kernel.browsers.list()) running.push(b.session_id);
    const leaked = running.filter((id) => ours.has(id));
    for (const id of leaked) await kernel.browsers.deleteByID(id).catch(() => undefined);
    log(`kernel: ${running.length} running account-wide, ours=${ours.size}, leaked=${leaked.length}`);
    if (leaked.length) ok = false;
    await site('/api/reset', { layout: 'v1' }).catch((e) => log(`layout reset failed: ${e}`));
    await resetSkillToVersion(CANCEL_SKILL_ID, 1).catch(() => undefined);
    log('cleanup: layout v1, skill restored to v1');
  }
  log(ok ? 'SMOKE PASSED' : 'SMOKE FAILED');
  await getMastra().shutdown().catch(() => undefined);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
