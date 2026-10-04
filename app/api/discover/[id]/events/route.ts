// GET /api/discover/:id/events — SSE: polls the discovery tables and sends the DiscoveryView whenever it
// changes; ends once the discovery is done/failed (A4, flag ADDON_DISCOVER).
import { flag } from '@/lib/addons/flags';
import { getDiscoveryView } from '@/lib/discover/race';
import { SSE_HEADERS, encodeComment } from '../../../_lib/sse';
import { jsonError, type IdContext } from '../../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: IdContext) {
  if (!flag('ADDON_DISCOVER')) return jsonError(404, 'Not found');
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return jsonError(404, 'Not found');
  let closed = false;
  request.signal.addEventListener('abort', () => (closed = true));
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        if (!closed) controller.enqueue(enc.encode(s));
      };
      let last = '';
      const deadline = Date.now() + 10 * 60_000;
      try {
        while (!closed && Date.now() < deadline) {
          const view = await getDiscoveryView(id).catch(() => null);
          if (!view) break;
          const key = JSON.stringify(view);
          if (key !== last) {
            last = key;
            send(`data: ${key}\n\n`);
          } else send(encodeComment('ping'));
          if (view.state === 'done' || view.state === 'failed') break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
