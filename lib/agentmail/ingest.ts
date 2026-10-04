// Inbound email → classify (Neon AI Gateway) → match skill → incoming_triggers (agent S4). Server-only.
import type { AgentMail } from 'agentmail';

type Message = AgentMail.Message;
import { DEMO_USER_ID, type EmailClassification } from '@/lib/contracts';
import { matchSkills } from '@/lib/skills/retrieve';
import { classifyEmailDetailed } from '@/lib/triggers/classify';
import { findTriggerIdByExternalId, insertEmailTrigger } from '@/lib/triggers/store';
import { agentInboxId, getAgentMail } from './client';

/** One shape for webhook (snake_case) and SDK (camelCase) messages. */
export interface InboundEmail {
  messageId: string;
  inboxId: string;
  threadId: string | null;
  from: string; // raw "Name <addr>"
  subject: string;
  text: string | null; // null when the webhook payload omitted it (>1 MB) → fetched
  receivedAt: string | null; // ISO
}

/** Raw AgentMail webhook body (snake_case). */
export interface AgentMailWebhookEvent {
  type?: string;
  event_type: string;
  event_id: string;
  message?: {
    inbox_id: string;
    thread_id?: string;
    message_id: string;
    from: string;
    to?: string[];
    subject?: string;
    text?: string;
    extracted_text?: string;
    preview?: string;
    labels?: string[];
    timestamp?: string;
    created_at?: string;
  };
}

export function fromWebhook(m: NonNullable<AgentMailWebhookEvent['message']>): InboundEmail {
  return {
    messageId: m.message_id,
    inboxId: m.inbox_id,
    threadId: m.thread_id ?? null,
    from: m.from,
    subject: m.subject ?? '',
    text: m.extracted_text ?? m.text ?? null,
    receivedAt: m.timestamp ?? m.created_at ?? null,
  };
}

export function fromSdk(m: Message): InboundEmail {
  return {
    messageId: m.messageId,
    inboxId: m.inboxId,
    threadId: m.threadId ?? null,
    from: m.from,
    subject: m.subject ?? '',
    text: m.extractedText ?? m.text ?? m.preview ?? null,
    receivedAt: toIso(m.timestamp ?? m.createdAt),
  };
}

function toIso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** "Lumen+ Billing <billing@x.to>" → { name: "Lumen+ Billing", address: "billing@x.to" }. */
export function parseAddress(raw: string): { name: string | null; address: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, address: m[2].trim().toLowerCase() };
  return { name: null, address: raw.trim().toLowerCase() };
}

/** Deterministic card title per kind (the model's own title is kept in the payload). */
function cardTitle(c: EmailClassification): string {
  switch (c.kind) {
    case 'renewal':
      return 'Membership renewal detected';
    case 'purchase':
      return 'Purchase detected';
    case 'appointment':
      return 'Appointment detected';
    default:
      return c.title;
  }
}

export type IngestResult =
  | { status: 'duplicate'; messageId: string; triggerId: string }
  | { status: 'skipped'; messageId: string; reason: string }
  | {
      status: 'ingested';
      messageId: string;
      triggerId: string;
      created: boolean;
      actionable: boolean;
      classifiedBy: 'gateway' | 'regex';
      classification: EmailClassification;
      matchedSkill: { id: string; title: string; score: number } | null;
    };

const MIN_MATCH_SCORE = 0.3;

/** Idempotent on messageId: dedupe → classify → match → insert. */
export async function ingestEmail(email: InboundEmail, userId: string = DEMO_USER_ID): Promise<IngestResult> {
  const existing = await findTriggerIdByExternalId(email.messageId);
  if (existing) return { status: 'duplicate', messageId: email.messageId, triggerId: existing };

  const sender = parseAddress(email.from);
  if (sender.address === email.inboxId.toLowerCase() || sender.address === agentInboxId().toLowerCase()) {
    return { status: 'skipped', messageId: email.messageId, reason: 'sent by the agent itself' };
  }

  let text = email.text;
  if (text === null) {
    const full = await getAgentMail().inboxes.messages.get(email.inboxId, email.messageId);
    text = full.extractedText ?? full.text ?? full.preview ?? '';
  }

  const { classification, by, error } = await classifyEmailDetailed({
    subject: email.subject,
    text,
    from: email.from,
    receivedAt: email.receivedAt,
  });
  if (error) console.warn(`[agentmail] gateway classification failed, used regex fallback: ${error}`);

  let matchedSkill: { id: string; title: string; score: number } | null = null;
  if (classification.actionable) {
    const [best] = await matchSkills(userId, classification.skillQuery, 1);
    if (best && best.score >= MIN_MATCH_SCORE) matchedSkill = { id: best.skillId, title: best.title, score: best.score };
  }

  const { id, created } = await insertEmailTrigger({
    userId,
    externalId: email.messageId,
    subject: email.subject || '(no subject)',
    fromAddress: sender.address,
    receivedAt: email.receivedAt,
    matchedSkillId: matchedSkill?.id ?? null,
    state: classification.actionable ? 'pending' : 'dismissed',
    payload: {
      title: cardTitle(classification),
      merchant: classification.merchant,
      amount: classification.amount,
      cadence: classification.cadence,
      dueLabel: classification.dueLabel,
      kind: classification.kind,
      classifiedTitle: classification.title,
      skillQuery: classification.skillQuery,
      confidence: classification.confidence,
      classifiedBy: by,
      matchScore: matchedSkill?.score ?? null,
      messageId: email.messageId,
      threadId: email.threadId,
      inboxId: email.inboxId,
      fromName: sender.name,
      fromAddress: sender.address,
      emailSubject: email.subject,
    },
  });

  return {
    status: 'ingested',
    messageId: email.messageId,
    triggerId: id,
    created,
    actionable: classification.actionable,
    classifiedBy: by,
    classification,
    matchedSkill,
  };
}

/** Marks a message handled in AgentMail so the sync fallback skips it. Best effort. */
export async function markProcessed(inboxId: string, messageId: string): Promise<void> {
  try {
    await getAgentMail().inboxes.messages.update(inboxId, messageId, { addLabels: ['processed'], removeLabels: ['unread'] });
  } catch (err) {
    console.warn(`[agentmail] could not label ${messageId} processed: ${(err as Error).message}`);
  }
}

/** Pull fallback: ingests unread messages from the agent inbox. */
export async function syncInbox(opts: { limit?: number; userId?: string } = {}): Promise<{ inboxId: string; checked: number; results: IngestResult[] }> {
  const inboxId = agentInboxId();
  const am = getAgentMail();
  const { messages } = await am.inboxes.messages.list(inboxId, { labels: ['unread'], limit: opts.limit ?? 20 });
  const results: IngestResult[] = [];
  for (const item of messages) {
    if (item.labels.includes('processed') || !item.labels.includes('received')) continue;
    try {
      const full = await am.inboxes.messages.get(inboxId, item.messageId);
      const r = await ingestEmail(fromSdk(full), opts.userId);
      results.push(r);
      await markProcessed(inboxId, item.messageId);
    } catch (err) {
      console.error(`[agentmail] sync failed for ${item.messageId}:`, err);
      results.push({ status: 'skipped', messageId: item.messageId, reason: (err as Error).message });
    }
  }
  return { inboxId, checked: messages.length, results };
}
