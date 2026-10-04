// incoming_triggers SQL for email-sourced triggers (agent S4). Server-only.
// lib/neon/repo.ts stays untouched: listTodayItems reads title/merchant/amount/dueLabel from payload.
import { getSql } from '@/lib/neon/db';

export interface EmailTriggerInsert {
  userId: string;
  externalId: string; // AgentMail message_id
  subject: string;
  fromAddress: string | null;
  receivedAt: string | null; // ISO
  payload: Record<string, unknown>;
  matchedSkillId: string | null;
  /** 'pending' shows on Today; non-actionable mail is stored as 'dismissed' (kept for dedupe). */
  state: 'pending' | 'dismissed';
}

export async function findTriggerIdByExternalId(externalId: string): Promise<string | null> {
  const sql = getSql();
  const rows = (await sql`SELECT id FROM incoming_triggers WHERE external_id = ${externalId}`) as { id: string }[];
  return rows[0]?.id ?? null;
}

/** Inserts once per externalId. Returns { id, created:false } when a concurrent ingest won the race. */
export async function insertEmailTrigger(t: EmailTriggerInsert): Promise<{ id: string; created: boolean }> {
  const sql = getSql();
  const rows = (await sql`
    INSERT INTO incoming_triggers (user_id, source, subject, payload, matched_skill_id, state, external_id, from_address, received_at)
    VALUES (${t.userId}, 'email', ${t.subject}, ${JSON.stringify(t.payload)}::jsonb, ${t.matchedSkillId}, ${t.state},
            ${t.externalId}, ${t.fromAddress}, ${t.receivedAt})
    ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO NOTHING
    RETURNING id`) as { id: string }[];
  if (rows[0]) return { id: rows[0].id, created: true };
  const existing = await findTriggerIdByExternalId(t.externalId);
  if (!existing) throw new Error(`insertEmailTrigger: conflict on ${t.externalId} but no row found`);
  return { id: existing, created: false };
}

export interface EmailTriggerSource {
  triggerId: string;
  fromName: string | null;
  fromAddress: string | null;
  subject: string;
  receivedAt: string | null;
  sourceLabel: string; // "From your inbox · Lumen+ Billing"
}

/** Email provenance for the user's recent email triggers (the Today card source line). */
export async function listEmailTriggerSources(userId: string, limit = 50): Promise<EmailTriggerSource[]> {
  const sql = getSql();
  const rows = (await sql`
    SELECT id, subject, from_address, received_at, payload
    FROM incoming_triggers
    WHERE user_id = ${userId} AND source = 'email' AND state <> 'dismissed'
    ORDER BY created_at DESC
    LIMIT ${limit}`) as { id: string; subject: string; from_address: string | null; received_at: string | Date | null; payload: unknown }[];
  return rows.map((r) => {
    const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload ?? {}) as Record<string, unknown>;
    const fromName = typeof p.fromName === 'string' && p.fromName ? p.fromName : null;
    return {
      triggerId: r.id,
      fromName,
      fromAddress: r.from_address,
      subject: r.subject,
      receivedAt: r.received_at ? new Date(r.received_at).toISOString() : null,
      sourceLabel: `From your inbox · ${fromName ?? r.from_address ?? 'unknown sender'}`,
    };
  });
}
