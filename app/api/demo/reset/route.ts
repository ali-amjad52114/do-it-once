import { listRuns, resetDemoState } from '@/lib/neon/repo';
import { DEMO_USER_ID, TERMINAL_STATES } from '@/lib/contracts';
import { getRunEngine } from '@/lib/engine';
import { errorMessage, handle } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DemoSiteResult = { ok: boolean; status?: number; error?: string };

async function resetDemoSite(): Promise<DemoSiteResult> {
  const base = process.env.DEMO_SITE_URL;
  if (!base) return { ok: false, error: 'DEMO_SITE_URL is not set' };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.DEMO_RESET_TOKEN) headers['x-reset-token'] = process.env.DEMO_RESET_TOKEN;
  try {
    // A full demo reset also puts the site back on layout v1 (the self-heal demo switches it to v2).
    const res = await fetch(new URL('/api/reset', base), {
      method: 'POST',
      headers,
      body: JSON.stringify({ layout: 'v1' }),
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    });
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `Demo site returned ${res.status}` };
  } catch (err) {
    return { ok: false, error: `Demo site unreachable: ${errorMessage(err)}` };
  }
}

/** Resets the demo site (best effort) and the DB demo state. `ok` reflects the DB reset. */
export const POST = handle(async () => {
  const demoSite = await resetDemoSite();
  // Stop active runs first: a run waiting for approval keeps its Kernel browser open on purpose,
  // and only stop() closes it. Otherwise each reset leaks a paid browser.
  let runs: Awaited<ReturnType<typeof listRuns>> = [];
  try {
    runs = (await listRuns(DEMO_USER_ID, { limit: 25 })) ?? [];
  } catch {
    /* best effort */
  }
  await Promise.allSettled(runs.filter((r) => !TERMINAL_STATES.includes(r.state)).map((r) => getRunEngine().stop(r.id)));
  await resetDemoState();
  return Response.json({ ok: true, demoSite });
});
