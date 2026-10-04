// REAL smoke for the A3 AI judge (Kernel + Neon AI Gateway + Neon). Uses .env (own Neon branch + DEMO_SITE_URL).
//   npx tsx scripts/smoke-judge.ts
// (a) real Cancel run → approve → succeeded → onRunVerified → judgment row (expect pass)
// (b) doctored: rules "pass" (canceled evidence text) but the screenshot is of the ACTIVE membership page → expect fail
// finally: demo site + demo state reset, no Kernel browser of ours left open.
import 'dotenv/config';
import Kernel from '@onkernel/sdk';
import { DEMO_USER_ID, TERMINAL_STATES, type RunState } from '@/lib/contracts';
import { getRunEngineWithIdle } from '@/lib/engine';
import { getMastra } from '@/lib/mastra';
import { getKernelAdapter } from '@/lib/kernel';
import { getRun, getSkill, listEvents, resetDemoState } from '@/lib/neon/repo';
import { CANCEL_SKILL_ID } from '@/lib/neon/seed-data';
import { combineVerdict, getJudgmentView, judgeRunDetailed, onRunVerified } from '@/lib/judge';

const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const demo = (process.env.DEMO_SITE_URL ?? '').replace(/\/$/, '');

async function siteReset() {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.DEMO_RESET_TOKEN) headers['x-reset-token'] = process.env.DEMO_RESET_TOKEN;
  const r = await fetch(`${demo}/api/reset`, { method: 'POST', headers, body: '{}' });
  if (!r.ok) throw new Error(`/api/reset HTTP ${r.status}`);
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

async function main() {
  if (!demo) throw new Error('DEMO_SITE_URL missing');
  const kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY! });
  const adapter = getKernelAdapter();
  const ours = new Set<string>();
  let runId: string | null = null;
  let okA = false;
  let okB = false;
  try {
    await siteReset();
    await resetDemoState();
    log('setup: demo site reset (membership active)');

    // (a) real run
    const engine = getRunEngineWithIdle();
    runId = (await engine.startRun({ skillId: CANCEL_SKILL_ID, userId: DEMO_USER_ID })).runId;
    log(`(a) run ${runId}`);
    const s1 = await waitFor(runId, ['waiting_approval'], 240_000);
    if (s1 !== 'waiting_approval') throw new Error(`(a) run ended in ${s1} before approval`);
    await engine.whenIdle(runId);
    await engine.approve(runId);
    await engine.whenIdle(runId);
    const run = await getRun(runId);
    log(`(a) run state=${run?.state} evidence=${JSON.stringify(run?.result?.evidenceText)}`);
    if (run?.state !== 'succeeded') throw new Error(`(a) run did not succeed: ${run?.error}`);
    await onRunVerified(runId);
    const view = await getJudgmentView(runId);
    const ja = view?.judgment;
    log(`(a) JUDGE: ${ja?.verdict} ${Math.round((ja?.confidence ?? 0) * 100)}% latency=${ja?.latencyMs}ms combined=${view?.combined}`);
    log(`    reasons: ${JSON.stringify(ja?.reasons)} evidence: ${JSON.stringify(ja?.quotedEvidence)}`);
    okA = ja?.verdict === 'pass' && view?.combined === 'succeeded';

    // (b) doctored: active membership screenshot + canceled evidence text
    await siteReset();
    log('(b) demo site reset → membership active again');
    const session = await adapter.open({ startUrl: `${demo}/account/membership` });
    ours.add(session.id);
    let shot: Buffer;
    let page: { url: string; text: string };
    try {
      await adapter.waitForText(session.id, 'Lumen', 15_000).catch(() => undefined);
      page = await adapter.readPage(session.id);
      shot = await adapter.screenshot(session.id);
    } finally {
      await adapter.close(session.id).catch(() => undefined);
    }
    log(`(b) captured ${page.url} (${shot.length} bytes png); page says: ${page.text.slice(0, 120)}…`);
    const skill = await getSkill(CANCEL_SKILL_ID);
    const doctored = await judgeRunDetailed({
      intent: 'Cancel the Lumen+ membership',
      verification: skill!.verification,
      finalUrl: page.url,
      pageText: (run.result?.evidenceText ?? ['Membership canceled', 'Renews: No']).join('\n'),
      screenshotPng: shot,
    });
    const combinedB = combineVerdict('succeeded', doctored.judgment);
    log(`(b) JUDGE: ${doctored.judgment.verdict} ${Math.round(doctored.judgment.confidence * 100)}% latency=${doctored.latencyMs}ms image=${doctored.imageUsed} combined=${combinedB}`);
    log(`    reasons: ${JSON.stringify(doctored.judgment.reasons)}`);
    okB = doctored.judgment.verdict === 'fail' && doctored.imageUsed && combinedB === 'needs_review';
  } finally {
    if (runId) {
      const r = await getRun(runId).catch(() => null);
      if (r?.browserSessionId) ours.add(r.browserSessionId);
      for (const e of await listEvents(runId).catch(() => [])) {
        if (e.type === 'browser.opened' && typeof e.metadata.browserSessionId === 'string') ours.add(e.metadata.browserSessionId);
      }
    }
    const running: string[] = [];
    for await (const b of kernel.browsers.list()) running.push(b.session_id);
    const leaked = running.filter((id) => ours.has(id));
    for (const id of leaked) await kernel.browsers.deleteByID(id).catch(() => undefined);
    log(`kernel: ours=${ours.size}, leaked=${leaked.length} (deleted)`);
    if (leaked.length) okA = okB = false;
    await siteReset().catch((e) => log(`site reset failed: ${e}`));
    await resetDemoState().catch(() => undefined);
    log('cleanup: demo site + demo state reset');
  }
  const ok = okA && okB;
  log(`(a) ${okA ? 'PASS' : 'FAIL'} · (b) ${okB ? 'PASS' : 'FAIL'} → ${ok ? 'SMOKE PASSED' : 'SMOKE FAILED'}`);
  await getMastra().shutdown().catch(() => undefined);
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
