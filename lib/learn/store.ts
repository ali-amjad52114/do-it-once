// teach_recordings + taught-skill SQL (agent K). Server-only. Kept out of lib/neon/repo.ts on purpose.
import { randomUUID } from 'node:crypto';
import type { Recording } from '@/lib/contracts';
import { getSql } from '@/lib/neon/db';
import { embedSkillTriggers } from '@/lib/skills/retrieve';
import { normalizeRecording, type TaughtSkillDraft } from './normalize';

export type TeachStatus = 'received' | 'normalized' | 'saved' | 'failed';

export interface TeachRecordingRow {
  id: string;
  userId: string;
  recording: Recording;
  status: TeachStatus;
  normalized: TaughtSkillDraft | null;
  skillId: string | null;
  skillStatus: string | null;
  error: string | null;
  createdAt: string;
}

type Row = Record<string, any>;
const j = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const map = (r: Row): TeachRecordingRow => ({
  id: r.id,
  userId: r.user_id,
  recording: j(r.recording),
  status: r.status,
  normalized: r.normalized ? j(r.normalized) : null,
  skillId: r.skill_id,
  skillStatus: r.skill_status ?? null,
  error: r.error,
  createdAt: new Date(r.created_at).toISOString(),
});

export async function insertRecording(userId: string, recording: Recording): Promise<string> {
  const sql = getSql();
  const [r] = await sql`INSERT INTO teach_recordings (user_id, recording) VALUES (${userId}, ${JSON.stringify(recording)}::jsonb) RETURNING id`;
  return r.id as string;
}

export async function listRecordings(userId: string, limit = 30): Promise<TeachRecordingRow[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT t.*, s.status AS skill_status FROM teach_recordings t LEFT JOIN personal_skills s ON s.id = t.skill_id
    WHERE t.user_id = ${userId} ORDER BY t.created_at DESC LIMIT ${limit}`;
  return rows.map(map);
}

export async function getRecording(id: string): Promise<TeachRecordingRow | null> {
  const sql = getSql();
  const [r] = await sql`
    SELECT t.*, s.status AS skill_status FROM teach_recordings t LEFT JOIN personal_skills s ON s.id = t.skill_id
    WHERE t.id = ${id}`;
  return r ? map(r) : null;
}

const inflight = new Map<string, Promise<TaughtSkillDraft>>();

/** Normalizes once (cached in teach_recordings.normalized); concurrent callers share the same LLM call. */
export function ensureNormalized(id: string, opts: { force?: boolean } = {}): Promise<TaughtSkillDraft> {
  const existing = inflight.get(id);
  if (existing) return existing;
  const p = (async () => {
    const rec = await getRecording(id);
    if (!rec) throw new Error(`Recording ${id} not found`);
    if (rec.normalized && !opts.force) return rec.normalized;
    const sql = getSql();
    try {
      const draft = await normalizeRecording(rec.recording);
      await sql`
        UPDATE teach_recordings SET normalized = ${JSON.stringify(draft)}::jsonb, error = NULL, updated_at = now(),
          status = CASE WHEN status = 'saved' THEN status ELSE 'normalized' END
        WHERE id = ${id}`;
      return draft;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await sql`UPDATE teach_recordings SET status = 'failed', error = ${msg}, updated_at = now() WHERE id = ${id}`;
      throw err;
    }
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

export interface TaughtSkillEdits {
  title?: string;
  description?: string;
  triggers?: string[];
  steps?: { sequence: number; intent: string }[];
}

async function tableExists(name: string): Promise<boolean> {
  const sql = getSql();
  const [r] = await sql`SELECT to_regclass(${'public.' + name}) IS NOT NULL AS ok`;
  return Boolean(r?.ok);
}

/**
 * Inserts the taught skill (new UUID, status 'draft', version 1) with steps, triggers, preferences and a
 * skill_versions row (reason 'teach') when that table exists, then embeds the triggers. Idempotent per recording.
 */
export async function saveTaughtSkill(recordingId: string, edits: TaughtSkillEdits = {}): Promise<{ skillId: string }> {
  const rec = await getRecording(recordingId);
  if (!rec) throw new Error(`Recording ${recordingId} not found`);
  if (rec.skillId) return { skillId: rec.skillId };
  const base = await ensureNormalized(recordingId);
  const draft: TaughtSkillDraft = {
    ...base,
    title: edits.title?.trim() || base.title,
    description: edits.description?.trim() ?? base.description,
    triggers: edits.triggers ? [...new Set(edits.triggers.map((t) => t.trim().toLowerCase()).filter(Boolean))] : base.triggers,
    steps: base.steps.map((s) => ({ ...s, intent: edits.steps?.find((e) => e.sequence === s.sequence)?.intent?.trim() || s.intent })),
  };

  const sql = getSql();
  const skillId = randomUUID();
  const userId = rec.userId;
  const steps = draft.steps.map((s) => ({ ...s, id: randomUUID(), skillId }));
  await sql.transaction([
    sql`
      INSERT INTO personal_skills (id, user_id, title, description, status, version, icon, target_domains, start_url, verification, value_per_year)
      VALUES (${skillId}, ${userId}, ${draft.title}, ${draft.description}, 'draft', 1, ${draft.icon}, ${draft.targetDomains},
              ${draft.startUrl}, ${JSON.stringify(draft.verification)}::jsonb, ${draft.valuePerYear ?? null})`,
    ...steps.map(
      (s) => sql`
        INSERT INTO skill_steps (id, skill_id, sequence, intent, action_type, target_description, input_source, expected_before,
                                 expected_after, locator_hint, requires_approval, config)
        VALUES (${s.id}, ${skillId}, ${s.sequence}, ${s.intent}, ${s.actionType}, ${s.targetDescription}, ${s.inputSource},
                ${s.expectedBefore}, ${s.expectedAfter}, ${s.locatorHint}, ${s.requiresApproval}, ${JSON.stringify(s.config)}::jsonb)`,
    ),
    ...draft.triggers.map(
      (t) => sql`INSERT INTO skill_triggers (skill_id, user_id, phrase) VALUES (${skillId}, ${userId}, ${t}) ON CONFLICT DO NOTHING`,
    ),
    ...Object.entries(draft.preferences).map(
      ([k, v]) => sql`INSERT INTO skill_preferences (skill_id, key, value) VALUES (${skillId}, ${k}, ${JSON.stringify(v)}::jsonb)`,
    ),
    sql`UPDATE teach_recordings SET status = 'saved', skill_id = ${skillId}, normalized = ${JSON.stringify(draft)}::jsonb, updated_at = now()
        WHERE id = ${recordingId}`,
  ]);

  if (await tableExists('skill_versions')) {
    try {
      const cols = new Set(
        ((await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'skill_versions'`) as Row[]).map(
          (r) => r.column_name as string,
        ),
      );
      const values: Record<string, unknown> = { skill_id: skillId, version: 1, reason: 'teach', steps: JSON.stringify(steps), note: 'Taught by recording' };
      const names = Object.keys(values).filter((c) => cols.has(c));
      const params = names.map((n) => values[n]);
      const ph = names.map((n, i) => (n === 'steps' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ');
      await sql.query(`INSERT INTO skill_versions (${names.join(', ')}) VALUES (${ph})`, params);
    } catch (err) {
      console.warn('[teach] skill_versions insert skipped:', err instanceof Error ? err.message : err);
    }
  }

  try {
    await embedSkillTriggers(skillId);
  } catch (err) {
    console.warn('[teach] embedSkillTriggers failed (keyword fallback still works):', err instanceof Error ? err.message : err);
  }
  return { skillId };
}

/** Promotes a taught draft skill to 'active' once a run of it succeeded with verification. Returns true if promoted. */
export async function promoteTaughtSkill(runId: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    UPDATE personal_skills s SET status = 'active', updated_at = now()
    FROM skill_runs r
    WHERE r.id = ${runId} AND r.skill_id = s.id AND r.state = 'succeeded' AND (r.result->>'success')::boolean IS TRUE
      AND s.status = 'draft' AND EXISTS (SELECT 1 FROM teach_recordings t WHERE t.skill_id = s.id)
    RETURNING s.id`;
  return rows.length > 0;
}

/** Lazy promotion for the /teach page: promotes taught drafts that already have a verified run. */
export async function promoteVerifiedTaughtSkills(userId: string): Promise<void> {
  const sql = getSql();
  await sql`
    UPDATE personal_skills s SET status = 'active', updated_at = now()
    WHERE s.user_id = ${userId} AND s.status = 'draft'
      AND EXISTS (SELECT 1 FROM teach_recordings t WHERE t.skill_id = s.id)
      AND EXISTS (SELECT 1 FROM skill_runs r WHERE r.skill_id = s.id AND r.state = 'succeeded' AND (r.result->>'success')::boolean IS TRUE)`;
}
