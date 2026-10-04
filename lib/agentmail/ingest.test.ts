import { afterEach, describe, expect, it, vi } from 'vitest';
import { Webhook } from 'svix';

const ingest = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('next/server', () => ({ after: (fn: () => unknown) => void fn() }));
vi.mock('@/lib/agentmail/ingest', async (orig) => {
  const real = await orig<typeof import('./ingest')>();
  return {
    ...real,
    ingestEmail: async (e: unknown) => {
      ingest.calls.push(e);
      return { status: 'skipped', messageId: 'x', reason: 'test' };
    },
    markProcessed: async () => {},
  };
});

import { fromWebhook, parseAddress } from './ingest';
import { POST } from '@/app/api/webhooks/agentmail/route';

const SECRET = `whsec_${Buffer.from('a-test-secret-of-some-length-123').toString('base64')}`;

describe('ingest helpers', () => {
  it('parses sender display name and address', () => {
    expect(parseAddress('Lumen+ Billing <Lumen-Billing-Demo@agentmail.to>')).toEqual({
      name: 'Lumen+ Billing',
      address: 'lumen-billing-demo@agentmail.to',
    });
    expect(parseAddress('"Acme, Inc." <a@acme.example>')).toEqual({ name: 'Acme, Inc.', address: 'a@acme.example' });
    expect(parseAddress('plain@x.example')).toEqual({ name: null, address: 'plain@x.example' });
  });

  it('normalizes the snake_case webhook message', () => {
    expect(
      fromWebhook({
        inbox_id: 'do-it-once-agent@agentmail.to',
        thread_id: 't1',
        message_id: '<m1@agentmail.to>',
        from: 'Lumen+ Billing <lumen-billing-demo@agentmail.to>',
        subject: 'Your Lumen+ Premium membership renews tomorrow',
        text: 'body',
        timestamp: '2026-10-04T15:00:00Z',
      }),
    ).toEqual({
      messageId: '<m1@agentmail.to>',
      inboxId: 'do-it-once-agent@agentmail.to',
      threadId: 't1',
      from: 'Lumen+ Billing <lumen-billing-demo@agentmail.to>',
      subject: 'Your Lumen+ Premium membership renews tomorrow',
      text: 'body',
      receivedAt: '2026-10-04T15:00:00Z',
    });
  });
});

describe('POST /api/webhooks/agentmail', () => {
  afterEach(() => {
    ingest.calls.length = 0;
    vi.unstubAllEnvs();
  });

  const body = JSON.stringify({
    type: 'event',
    event_type: 'message.received',
    event_id: 'evt_1',
    message: {
      inbox_id: 'do-it-once-agent@agentmail.to',
      message_id: '<m1@agentmail.to>',
      from: 'Lumen+ Billing <lumen-billing-demo@agentmail.to>',
      subject: 'Your Lumen+ Premium membership renews tomorrow',
      text: 'Renews tomorrow at $19/month',
    },
  });

  function signed(payload: string, secret = SECRET): Request {
    const id = 'msg_1';
    const ts = new Date();
    const sig = new Webhook(secret).sign(id, ts, payload);
    return new Request('http://localhost/api/webhooks/agentmail', {
      method: 'POST',
      body: payload,
      headers: { 'svix-id': id, 'svix-timestamp': String(Math.floor(ts.getTime() / 1000)), 'svix-signature': sig },
    });
  }

  it('accepts a valid signature and ingests the message', async () => {
    vi.stubEnv('AGENTMAIL_WEBHOOK_SECRET', SECRET);
    vi.stubEnv('AGENTMAIL_INBOX_ID', 'do-it-once-agent@agentmail.to');
    const res = await POST(signed(body));
    expect(res.status).toBe(200);
    expect(ingest.calls).toHaveLength(1);
    expect(ingest.calls[0]).toMatchObject({ messageId: '<m1@agentmail.to>', text: 'Renews tomorrow at $19/month' });
  });

  it('rejects a bad signature and a tampered body', async () => {
    vi.stubEnv('AGENTMAIL_WEBHOOK_SECRET', SECRET);
    const other = `whsec_${Buffer.from('another-secret-of-some-length-456').toString('base64')}`;
    expect((await POST(signed(body, other))).status).toBe(400);
    const req = signed(body);
    const tampered = new Request(req.url, { method: 'POST', headers: req.headers, body: body.replace('$19', '$1') });
    expect((await POST(tampered)).status).toBe(400);
    expect(ingest.calls).toHaveLength(0);
  });

  it('ignores mail for other inboxes', async () => {
    vi.stubEnv('AGENTMAIL_WEBHOOK_SECRET', SECRET);
    vi.stubEnv('AGENTMAIL_INBOX_ID', 'someone-else@agentmail.to');
    const res = await POST(signed(body));
    expect(await res.json()).toMatchObject({ ignored: 'not the agent inbox' });
    expect(ingest.calls).toHaveLength(0);
  });
});
