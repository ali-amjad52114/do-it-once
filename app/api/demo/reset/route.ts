import { resetDemoState } from '@/lib/neon/repo';
import { errorMessage, handle } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DemoSiteResult = { ok: boolean; status?: number; error?: string };

async function resetDemoSite(): Promise<DemoSiteResult> {
  const base = process.env.DEMO_SITE_URL;
  if (!base) return { ok: false, error: 'DEMO_SITE_URL is not set' };
  const headers: Record<string, string> = {};
  if (process.env.DEMO_RESET_TOKEN) headers['x-reset-token'] = process.env.DEMO_RESET_TOKEN;
  try {
    const res = await fetch(new URL('/api/reset', base), {
      method: 'POST',
      headers,
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
  await resetDemoState();
  return Response.json({ ok: true, demoSite });
});
