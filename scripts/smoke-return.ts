// REAL end-to-end smoke for the "Return online order" skill (agent R):
//   reset demo site + DB → startRun → waiting_approval (title + payload) → approve → succeeded
//   → post-actions (label saved to the Sprite or Neon; calendar via Executor or .ics) → demo /api/state has the return
//   → our Kernel browser is gone.
// Usage: npx tsx scripts/smoke-return.ts
import 'dotenv/config';
import Kernel from '@onkernel/sdk';
import { DEMO_USER_ID, TERMINAL_STATES } from '@/lib/contracts';
import { getRunEngineWithIdle } from '@/lib/engine';
import { flushTraces } from '@/lib/mastra';
import { getLatestApproval, getRun, listEvents, resetDemoState } from '@/lib/neon/repo';
import { RETURN_SKILL_ID, demoSiteUrl } from '@/lib/neon/seed-data';

const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
  log(`ok  ${msg}`);
}

async function waitFor(runId: string, pred: (s: string) => boolean, ms: number) {
  const end = Date.now() + ms;
  for (;;) {
    const run = await getRun(runId);
    if (run && pred(run.state)) return run;
    if (Date.now() > end) throw new Error(`timeout; state=${run?.state} error=${run?.error}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main() {
  const demo = demoSiteUrl();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.DEMO_RESET_TOKEN) headers['x-reset-token'] = process.env.DEMO_RESET_TOKEN;
  const reset = await fetch(`${demo}/api/reset`, { method: 'POST', headers, body: JSON.stringify({ layout: 'v1' }) });
  check(reset.ok, `demo site reset (${demo})`);
  await resetDemoState();
  log('db demo state reset');

  const engine = getRunEngineWithIdle();
  const sessions = new Set<string>();
  let runId = '';
  try {
    ({ runId } = await engine.startRun({ skillId: RETURN_SKILL_ID, userId: DEMO_USER_ID }));
    log(`run ${runId} started`);
    const waiting = await waitFor(runId, (s) => s === 'waiting_approval' || TERMINAL_STATES.includes(s as never), 240_000);
    if (waiting.browserSessionId) sessions.add(waiting.browserSessionId);
    check(waiting.state === 'waiting_approval', `waiting_approval (error: ${waiting.error ?? '-'})`);
    const approval = await getLatestApproval(runId);
    check(approval?.title === 'Return Lumen Aura headphones ($129.00)?', `approval title "${approval?.title}"`);
    check(String(approval?.payload.pageUrl ?? '').includes('/return/review'), `approval payload ${JSON.stringify(approval?.payload)}`);
    await engine.whenIdle(runId);

    await engine.approve(runId);
    log('approved');
    await engine.whenIdle(runId);
    const done = await getRun(runId);
    if (done?.browserSessionId) sessions.add(done.browserSessionId);
    check(done?.state === 'succeeded', `succeeded (error: ${done?.error ?? '-'}) — ${done?.result?.summary}`);
    check(/\/store\/returns\/RMA-/.test(done.result?.finalUrl ?? ''), `final url ${done.result?.finalUrl}`);
    log(`evidence: ${JSON.stringify(done.result?.evidenceText)}`);

    const events = await listEvents(runId);
    console.log('\n── timeline ──');
    for (const e of events) console.log(`  #${String(e.sequence).padStart(2)} ${e.type.padEnd(17)} ${e.message}`);
    console.log('');
    const saved = events.find((e) => e.type === 'workspace.saved');
    check(saved, `label saved → ${saved?.metadata.location}: ${saved?.metadata.path}`);
    const cal = events.find((e) => e.type === 'tool.called');
    check(cal, `calendar via ${cal?.metadata.via}: ${cal?.metadata.detail}`);

    const state = (await (await fetch(`${demo}/api/state`)).json()) as { returns?: Array<Record<string, unknown>> };
    const ret = state.returns?.[0];
    check(ret?.status === 'started', `demo /api/state has return ${ret?.rma} (${ret?.refundLabel}, ${ret?.dropOffLabel}, ${ret?.labelFormatLabel}, ${ret?.reason})`);
    check(
      ret?.refundLabel === 'Original payment method (Visa •••• 4242)' && ret?.dropOffLabel === 'UPS Store' && ret?.labelFormatLabel === 'QR code' && ret?.reason === 'No longer needed',
      'demo return used the saved preferences',
    );
  } finally {
    await flushTraces().catch(() => undefined);
    const kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY });
    const running: string[] = [];
    for await (const b of kernel.browsers.list()) running.push(b.session_id);
    const leaked = running.filter((id) => sessions.has(id));
    for (const id of leaked) await kernel.browsers.deleteByID(id).catch(() => undefined);
    log(`kernel: ours=${[...sessions].join(',') || '-'} leaked=${leaked.length}${leaked.length ? ' (deleted now)' : ''}`);
  }
  log('SMOKE PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
