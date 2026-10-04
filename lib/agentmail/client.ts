// AgentMail client + inbox setup (agent S4). Server-only.
import { createHash } from 'node:crypto';
import { AgentMailClient } from 'agentmail';
import { env } from '@/lib/env';

let client: AgentMailClient | null = null;

export function getAgentMail(): AgentMailClient {
  if (!client) client = new AgentMailClient({ apiKey: env('AGENTMAIL_API_KEY') });
  return client;
}

export const AGENT_INBOX = {
  username: 'do-it-once-agent',
  displayName: 'Do It Once Agent',
  clientId: 'do-it-once-agent-v1',
} as const;

export const DEMO_SENDER_INBOX = {
  username: 'lumen-billing-demo',
  displayName: 'Lumen+ Billing',
  clientId: 'do-it-once-lumen-billing-demo-v1',
} as const;

export const WEBHOOK_CLIENT_ID = 'do-it-once-agentmail-webhook-v1';

/** The agent's inbox id (= its email address). */
export function agentInboxId(): string {
  return process.env.AGENTMAIL_INBOX_ID || `${AGENT_INBOX.username}@agentmail.to`;
}

export function demoSenderInboxId(): string {
  return process.env.AGENTMAIL_SENDER_INBOX_ID || `${DEMO_SENDER_INBOX.username}@agentmail.to`;
}

export interface InboxRef {
  inboxId: string;
  displayName: string | null;
  how: 'created-or-existing' | 'reused';
}

type InboxSpec = { username: string; displayName: string; clientId: string };

/**
 * Idempotent: `clientId` returns the same inbox on re-run. If creation fails (inbox limit on the
 * free tier, or the username is taken globally), reuses an existing inbox from the account that is
 * not in `exclude`, preferring one whose clientId/username matches.
 */
export async function ensureInbox(spec: InboxSpec, exclude: string[] = []): Promise<InboxRef> {
  const am = getAgentMail();
  try {
    const inbox = await am.inboxes.create({ username: spec.username, displayName: spec.displayName, clientId: spec.clientId });
    return { inboxId: inbox.inboxId, displayName: inbox.displayName ?? null, how: 'created-or-existing' };
  } catch (err) {
    const { inboxes } = await am.inboxes.list({ limit: 50 });
    const usable = inboxes.filter((i) => !exclude.includes(i.inboxId));
    const pick =
      usable.find((i) => i.clientId === spec.clientId) ??
      usable.find((i) => i.inboxId.startsWith(`${spec.username}@`)) ??
      usable[0];
    if (!pick) throw new Error(`Could not create or reuse an inbox for ${spec.username}: ${(err as Error).message}`);
    return { inboxId: pick.inboxId, displayName: pick.displayName ?? null, how: 'reused' };
  }
}

/** Creates (or replaces, if the URL changed) the message.received webhook scoped to the agent inbox. */
export async function ensureWebhook(url: string, inboxId: string): Promise<{ webhookId: string; secret: string; url: string; replaced: boolean }> {
  const am = getAgentMail();
  const { webhooks } = await am.webhooks.list({ limit: 50 });
  const mine = webhooks.filter((w) => w.clientId?.startsWith(WEBHOOK_CLIENT_ID));
  const exact = mine.find((w) => w.url === url && (w.inboxIds ?? []).includes(inboxId));
  if (exact) {
    if (!exact.enabled) await am.webhooks.update(exact.webhookId, { enabled: true });
    const full = await am.webhooks.get(exact.webhookId);
    return { webhookId: full.webhookId, secret: full.secret, url: full.url, replaced: false };
  }
  // Webhook URLs cannot be updated: delete stale ones (old tunnel URLs) and create a fresh one.
  for (const w of mine) await am.webhooks.delete(w.webhookId);
  const wh = await am.webhooks.create({
    url,
    eventTypes: ['message.received'],
    inboxIds: [inboxId],
    // Per-URL clientId: re-running with the same URL is idempotent; a new tunnel URL gets a new webhook.
    clientId: `${WEBHOOK_CLIENT_ID}-${createHash('sha256').update(`${url}|${inboxId}`).digest('hex').slice(0, 12)}`,
  });
  return { webhookId: wh.webhookId, secret: wh.secret, url: wh.url, replaced: mine.length > 0 };
}
