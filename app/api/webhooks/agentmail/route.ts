// AgentMail webhook (message.received) → Svix verification on the RAW body → ingest after responding.
import { after } from 'next/server';
import { Webhook } from 'svix';
import { fromWebhook, ingestEmail, markProcessed, type AgentMailWebhookEvent } from '@/lib/agentmail/ingest';
import { agentInboxId } from '@/lib/agentmail/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.AGENTMAIL_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: 'AGENTMAIL_WEBHOOK_SECRET is not set' }, { status: 500 });

  const raw = await request.text(); // never parse before verifying
  let evt: AgentMailWebhookEvent;
  try {
    // svix 2.6: verify() throws on a bad signature and returns undefined (no parsed payload).
    new Webhook(secret).verify(raw, {
      'svix-id': request.headers.get('svix-id') ?? '',
      'svix-timestamp': request.headers.get('svix-timestamp') ?? '',
      'svix-signature': request.headers.get('svix-signature') ?? '',
    });
  } catch {
    return Response.json({ error: 'invalid signature' }, { status: 400 });
  }
  try {
    evt = JSON.parse(raw) as AgentMailWebhookEvent;
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const m = evt.message;
  if (evt.event_type === 'message.received' && m) {
    if (m.inbox_id.toLowerCase() !== agentInboxId().toLowerCase()) {
      return Response.json({ ok: true, ignored: 'not the agent inbox' });
    }
    // Respond fast; classification (LLM) runs after the response. Idempotent on message_id.
    after(async () => {
      try {
        const result = await ingestEmail(fromWebhook(m));
        console.log(`[agentmail] webhook ${evt.event_id} ${m.message_id} → ${result.status}`);
        if (result.status !== 'skipped') await markProcessed(m.inbox_id, m.message_id);
      } catch (err) {
        console.error(`[agentmail] webhook ingest failed for ${m.message_id}:`, err);
      }
    });
  }
  return Response.json({ ok: true });
}
