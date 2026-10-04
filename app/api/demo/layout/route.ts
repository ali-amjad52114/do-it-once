// Demo control: "the website changes". Switches the Lumen+ demo site between layout v1 and v2
// (v2 renames/moves Billing → Plan & payments, etc.) so the self-heal story can be shown live.
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ layout: z.enum(['v1', 'v2']) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Body must be {"layout":"v1"|"v2"}' }, { status: 400 });
  const base = process.env.DEMO_SITE_URL;
  if (!base) return Response.json({ error: 'DEMO_SITE_URL is not set' }, { status: 500 });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.DEMO_RESET_TOKEN) headers['x-reset-token'] = process.env.DEMO_RESET_TOKEN;
  try {
    const res = await fetch(new URL('/api/layout', base), {
      method: 'POST',
      headers,
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    });
    if (!res.ok) return Response.json({ error: `Demo site returned ${res.status}` }, { status: 502 });
    return Response.json({ ok: true, layout: parsed.data.layout });
  } catch (err) {
    return Response.json({ error: `Demo site unreachable: ${(err as Error).message}` }, { status: 502 });
  }
}
