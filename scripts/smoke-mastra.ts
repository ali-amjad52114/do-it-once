// REAL end-to-end smoke for the Mastra-backed run engine (agent M1). Costs a little Kernel time.
//   npx tsx scripts/smoke-mastra.ts
// Uses .env (your own Neon branch + DEMO_SITE_URL). Steps:
//   reset demo site + DB → startRun (Mastra choreRun) → waiting_approval (snapshot suspended in Neon)
//   → approve FROM A NEW PROCESS (child tsx: fresh Mastra loads the snapshot from Postgres and resumes)
//   → succeeded → print the trace span names → make sure no Kernel browser of this run is left running.
// Child mode (internal): npx tsx scripts/smoke-mastra.ts --approve <runId>
import 'dotenv/config';
import { spawn } from 'node:child_process';
import Kernel from '@onkernel/sdk';
import { DEMO_USER_ID, TERMINAL_STATES, type RunState } from '@/lib/contracts';
import { getRunEngineWithIdle } from '@/lib/engine';
import { flushTraces, getMastra, getRunTrace } from '@/lib/mastra';
import { getRun, listEvents } from '@/lib/neon/repo';
import { CANCEL_SKILL_ID, DEMO_TRIGGER_ID } from '@/lib/neon/seed-data';

const t0 = Date.now();
const since = (t: number) => `${((Date.now() - t) / 1000).toFixed(1)}s`;
const log = (msg: string) => console.log(`[${since(t0)}] ${msg}`);

function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: true, env: { ...process.env, ...env } });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function waitForState(runId: string, want: RunState[], timeoutMs: number): Promise<RunState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await getRun(runId);
    if (r && (want.includes(r.state) || TERMINAL_STATES.includes(r.state))) return r.state;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${want.join('/')} (state: ${r?.state})`);
    await new Promise((res) => setTimeout(res, 500));
  }
}

async function childApprove(runId: string) {
  // Fresh process: nothing in memory. getRunEngine → getMastra → PostgresStore → snapshot by runId.
  const engine = getRunEngineWithIdle();
  const snap = await getMastra().getWorkflow('choreRun').getWorkflowRunById(runId);
  console.log(`  [child pid ${process.pid}] snapshot in Postgres: status=${snap?.status}`);
  if (snap?.status !== 'suspended') throw new Error('expected a suspended workflow snapshot');
  const t = Date.now();
  await engine.approve(runId);
  await engine.whenIdle(runId);
  await flushTraces();
  const r = await getRun(runId);
  console.log(`  [child] resumed + finished in ${since(t)}: state=${r?.state}`);
  process.exit(r?.state === 'succeeded' ? 0 : 1);
}

async function main() {
  const demo = process.env.DEMO_SITE_URL;
  if (!demo) throw new Error('DEMO_SITE_URL missing');
  if (!process.env.KERNEL_API_KEY) throw new Error('KERNEL_API_KEY missing');
  const kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY });
  let runId: string | null = null;
  let ok = false;

  try {
    // 1. Reset demo site + DB demo state.
    const headers: Record<string, string> = {};
    if (process.env.DEMO_RESET_TOKEN) headers['x-reset-token'] = process.env.DEMO_RESET_TOKEN;
    const reset = await fetch(`${demo.replace(/\/$/, '')}/api/reset`, { method: 'POST', headers });
    if (!reset.ok) throw new Error(`demo reset failed: HTTP ${reset.status}`);
    log(`demo site reset (${demo})`);
    const seedCode = await run('npx', ['tsx', 'scripts/seed.ts', '--reset'], { DOTENV_CONFIG_PATH: '.env' });
    if (seedCode !== 0) throw new Error('seed --reset failed');
    log('db reset');

    // 2. Start the run (Mastra workflow choreRun, runId = skill_runs.id).
    const engine = getRunEngineWithIdle();
    const tStart = Date.now();
    ({ runId } = await engine.startRun({ skillId: CANCEL_SKILL_ID, userId: DEMO_USER_ID, triggerId: DEMO_TRIGGER_ID }));
    log(`started run ${runId}`);
    const state = await waitForState(runId, ['waiting_approval'], 180_000);
    await engine.whenIdle(runId);
    log(`state=${state} after ${since(tStart)}`);
    if (state !== 'waiting_approval') throw new Error(`expected waiting_approval, got ${state}`);
    const snap = await getMastra().getWorkflow('choreRun').getWorkflowRunById(runId);
    log(`parent sees Mastra snapshot status=${snap?.status}`);
    await flushTraces();

    // 3. Approve from a NEW process (proves resume-from-Postgres).
    const tApprove = Date.now();
    log('spawning a new tsx process to approve…');
    const code = await run('npx', ['tsx', 'scripts/smoke-mastra.ts', '--approve', runId]);
    log(`child exited with ${code} after ${since(tApprove)}`);

    // 4. Verify outcome.
    const final = await getRun(runId);
    const events = await listEvents(runId);
    console.log(events.map((e) => `  ${String(e.sequence).padStart(2)} ${e.type.padEnd(18)} ${e.message}`).join('\n'));
    const siteState = (await (await fetch(`${demo.replace(/\/$/, '')}/api/state`)).json()) as { status?: string };
    log(`run state=${final?.state}; demo site membership=${siteState.status}`);

    // 5. Trace.
    const trace = await getRunTrace(runId);
    log(`trace ${trace.traceId}: ${trace.spans.length} spans`);
    for (const s of trace.spans) console.log(`  ${s.spanType.padEnd(26)} ${s.name}${s.durationMs != null ? `  (${s.durationMs} ms)` : ''}${s.error ? `  ERROR ${s.error}` : ''}`);

    ok = code === 0 && final?.state === 'succeeded' && siteState.status === 'canceled' && trace.spans.length > 0;
  } finally {
    // 6. No Kernel browser of this run may be left running.
    const ours = new Set<string>();
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
    log(`kernel: ${running.length} browser(s) running account-wide, ours used=${[...ours].join(',') || '-'}, leaked=${leaked.length}${leaked.length ? ' (deleted now)' : ''}`);
    if (leaked.length) ok = false;
  }

  log(ok ? 'SMOKE PASSED' : 'SMOKE FAILED');
  await getMastra().shutdown().catch(() => undefined);
  process.exit(ok ? 0 : 1);
}

const approveIdx = process.argv.indexOf('--approve');
(approveIdx >= 0 ? childApprove(process.argv[approveIdx + 1]) : main()).catch((err) => {
  console.error(err);
  process.exit(1);
});
