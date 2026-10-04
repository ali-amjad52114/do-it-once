// REAL Teach Mode smoke (agent K): sample cancel-path recording → POST /api/teach/recordings (route handler,
// with a chrome-extension Origin) → normalize (Neon AI Gateway) → save draft skill (+ embeddings) →
// REAL Kernel replay via getRunEngine → waiting_approval → approve → succeeded → promoted to active.
//   npx tsx scripts/smoke-teach.ts
import 'dotenv/config';
import Kernel from '@onkernel/sdk';
import { DEMO_USER_ID, TERMINAL_STATES, type RunState } from '@/lib/contracts';
import { getRunEngineWithIdle } from '@/lib/engine';
import { flushTraces } from '@/lib/mastra';
import { getRun, getSkill, listEvents } from '@/lib/neon/repo';
import { sampleCancelRecording } from '@/lib/learn/sample';
import { ensureNormalized } from '@/lib/learn/store';
import { promoteTaughtSkill, saveTaughtSkill } from '@/lib/learn/save';
import { GET as listRoute, OPTIONS, POST } from '@/app/api/teach/recordings/route';

const t0 = Date.now();
const since = (t: number) => `${((Date.now() - t) / 1000).toFixed(1)}s`;
const log = (msg: string) => console.log(`[${since(t0)}] ${msg}`);
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

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

async function main() {
  const demo = (process.env.DEMO_SITE_URL ?? '').replace(/\/+$/, '');
  if (!demo) throw new Error('DEMO_SITE_URL missing');
  const kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY });
  let runId: string | null = null;
  let ok = false;
  try {
    await resetDemo(demo);
    log(`demo site reset (${demo})`);

    // 1. POST the recording like the extension does (CORS preflight + POST).
    const pre = OPTIONS(new Request('http://x/api/teach/recordings', { method: 'OPTIONS', headers: { origin: EXT } }));
    log(`OPTIONS ${pre.status} allow-origin=${pre.headers.get('access-control-allow-origin')}`);
    const res = await POST(
      new Request('http://x/api/teach/recordings', {
        method: 'POST',
        headers: { origin: EXT, 'content-type': 'application/json' },
        body: JSON.stringify(sampleCancelRecording(demo)),
      }),
    );
    const { id } = (await res.json()) as { id: string };
    if (!res.ok || !id) throw new Error(`POST failed: ${res.status}`);
    log(`POST /api/teach/recordings ${res.status} → ${id} (CORS ${res.headers.get('access-control-allow-origin')})`);

    // 2. Normalize (Neon AI Gateway, MODELS.smart) + save.
    const tN = Date.now();
    const draft = await ensureNormalized(id);
    log(`normalized in ${since(tN)}: "${draft.title}" icon=${draft.icon}`);
    const { skillId } = await saveTaughtSkill(id);
    const skill = await getSkill(skillId);
    if (!skill) throw new Error('saved skill not found');
    log(`saved skill ${skillId} status=${skill.status} v${skill.version}`);
    for (const s of skill.steps) {
      console.log(
        `  ${s.sequence}. [${s.actionType}] ${s.intent}${s.requiresApproval ? `  ⚠ APPROVAL "${s.config.approval?.title}"` : ''}\n` +
          `     input=${s.inputSource ?? '-'} hint=${s.locatorHint ?? '-'} match=${s.config.matchText ?? '-'} expect=${s.expectedAfter ?? '-'}`,
      );
    }
    console.log(`  triggers: ${skill.triggers.join(' | ')}`);
    console.log(`  preferences: ${JSON.stringify(skill.preferences)}`);
    console.log(`  verification: ${JSON.stringify(skill.verification)}`);
    const list = (await (await listRoute(new Request('http://x/api/teach/recordings'))).json()) as { recordings: { id: string; status: string }[] };
    log(`GET list: ${list.recordings.find((r) => r.id === id)?.status}`);

    // 3. REAL replay on Kernel.
    const engine = getRunEngineWithIdle();
    const tRun = Date.now();
    ({ runId } = await engine.startRun({ skillId, userId: DEMO_USER_ID }));
    log(`started run ${runId}`);
    const s1 = await waitForState(runId, ['waiting_approval'], 240_000);
    await engine.whenIdle(runId);
    log(`state=${s1} after ${since(tRun)}`);
    if (s1 !== 'waiting_approval') throw new Error(`expected waiting_approval, got ${s1}: ${(await getRun(runId))?.error}`);
    const tA = Date.now();
    await engine.approve(runId);
    const s2 = await waitForState(runId, ['succeeded'], 180_000);
    await engine.whenIdle(runId);
    log(`after approve: state=${s2} in ${since(tA)} (total run ${since(tRun)})`);
    const events = await listEvents(runId);
    console.log(events.map((e) => `  ${String(e.sequence).padStart(2)} ${e.type.padEnd(18)} ${e.message}`).join('\n'));
    const promoted = await promoteTaughtSkill(runId);
    const after = await getSkill(skillId);
    const site = (await (await fetch(`${demo}/api/state`)).json()) as { status?: string };
    log(`promoted=${promoted} skill status=${after?.status}; demo membership=${site.status}`);
    ok = s2 === 'succeeded' && after?.status === 'active' && site.status === 'canceled';
  } finally {
    await flushTraces().catch(() => undefined);
    await resetDemo(demo).catch((e) => log(`reset failed: ${e}`));
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
    const leaked = running.filter((x) => ours.has(x));
    for (const x of leaked) await kernel.browsers.deleteByID(x).catch(() => undefined);
    log(`demo reset; kernel: ${running.length} running account-wide, ours=${[...ours].join(',') || '-'}, leaked=${leaked.length}`);
    if (leaked.length) ok = false;
  }
  log(ok ? 'SMOKE PASSED' : 'SMOKE FAILED');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
