// Skill versions + pending heals in Neon (server-only). See db/migrations/004_skill_versions.sql.
import type { SkillStep, SkillVersion } from '@/lib/contracts';
import { getSql } from '@/lib/neon/db';

type Row = Record<string, any>;
const parse = <T>(v: unknown, fb: T): T => (v == null ? fb : ((typeof v === 'string' ? JSON.parse(v) : v) as T));

function mapVersion(r: Row): SkillVersion {
  return {
    skillId: r.skill_id,
    version: Number(r.version),
    reason: r.reason,
    steps: parse<SkillStep[]>(r.steps, []),
    note: r.note,
    createdAt: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
  };
}

export async function listSkillVersions(skillId: string): Promise<SkillVersion[]> {
  const sql = getSql();
  const rows = await sql`SELECT * FROM skill_versions WHERE skill_id = ${skillId} ORDER BY version DESC`;
  return rows.map(mapVersion);
}

export async function savePendingHeal(input: { runId: string; skillId: string; baseVersion: number; steps: SkillStep[]; note: string }) {
  const sql = getSql();
  await sql`
    INSERT INTO skill_heals (run_id, skill_id, base_version, steps, note, status)
    VALUES (${input.runId}, ${input.skillId}, ${input.baseVersion}, ${JSON.stringify(input.steps)}::jsonb, ${input.note}, 'pending')
    ON CONFLICT (run_id) DO UPDATE SET steps = EXCLUDED.steps, note = EXCLUDED.note, base_version = EXCLUDED.base_version, status = 'pending'`;
}

export async function getPendingHeal(runId: string): Promise<{ skillId: string; baseVersion: number; steps: SkillStep[]; note: string | null } | null> {
  const sql = getSql();
  const [r] = await sql`SELECT * FROM skill_heals WHERE run_id = ${runId} AND status = 'pending'`;
  return r ? { skillId: r.skill_id, baseVersion: Number(r.base_version), steps: parse<SkillStep[]>(r.steps, []), note: r.note } : null;
}

const backfillQuery = (sql: ReturnType<typeof getSql>, skillId: string) => sql`
  INSERT INTO skill_versions (skill_id, version, reason, steps, note)
  SELECT p.id, p.version, 'seed',
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', s.id, 'skillId', s.skill_id, 'sequence', s.sequence, 'intent', s.intent, 'actionType', s.action_type,
      'targetDescription', s.target_description, 'inputSource', s.input_source, 'expectedBefore', s.expected_before,
      'expectedAfter', s.expected_after, 'locatorHint', s.locator_hint, 'requiresApproval', s.requires_approval,
      'config', s.config) ORDER BY s.sequence) FROM skill_steps s WHERE s.skill_id = p.id), '[]'::jsonb),
    'Learned path'
  FROM personal_skills p WHERE p.id = ${skillId}
  ON CONFLICT (skill_id, version) DO NOTHING`;

function replaceStepsQueries(sql: ReturnType<typeof getSql>, skillId: string, steps: SkillStep[]) {
  return [
    sql`DELETE FROM skill_steps WHERE skill_id = ${skillId}`,
    ...steps.map(
      (st) => sql`
        INSERT INTO skill_steps (id, skill_id, sequence, intent, action_type, target_description, input_source,
          expected_before, expected_after, locator_hint, requires_approval, config)
        VALUES (${st.id}, ${skillId}, ${st.sequence}, ${st.intent}, ${st.actionType}, ${st.targetDescription}, ${st.inputSource},
          ${st.expectedBefore}, ${st.expectedAfter}, ${st.locatorHint}, ${st.requiresApproval}, ${JSON.stringify(st.config)}::jsonb)`,
    ),
  ];
}

/**
 * After a verified success: write version N+1 (reason 'heal'), bump personal_skills.version, replace skill_steps.
 * Backfills the base version row first so history always exists. Returns null if the run had no pending heal.
 */
export async function commitPendingHeal(runId: string): Promise<{ skillId: string; version: number; note: string | null } | null> {
  const pending = await getPendingHeal(runId);
  if (!pending) return null;
  const sql = getSql();
  const [cur] = await sql`SELECT version FROM personal_skills WHERE id = ${pending.skillId}`;
  if (!cur) return null;
  const version = Number(cur.version) + 1;
  const steps = pending.steps.map((s) => ({ ...s, skillId: pending.skillId }));
  await sql.transaction([
    backfillQuery(sql, pending.skillId),
    sql`
      INSERT INTO skill_versions (skill_id, version, reason, steps, note)
      VALUES (${pending.skillId}, ${version}, 'heal', ${JSON.stringify(steps)}::jsonb, ${pending.note})`,
    sql`UPDATE personal_skills SET version = ${version}, updated_at = now() WHERE id = ${pending.skillId}`,
    ...replaceStepsQueries(sql, pending.skillId, steps),
    sql`UPDATE skill_heals SET status = 'applied' WHERE run_id = ${runId}`,
  ]);
  return { skillId: pending.skillId, version, note: pending.note };
}

/** Demo/smoke reset: restore a recorded version's steps and drop newer versions. */
export async function resetSkillToVersion(skillId: string, version: number): Promise<boolean> {
  const sql = getSql();
  await backfillQuery(sql, skillId);
  const [row] = await sql`SELECT * FROM skill_versions WHERE skill_id = ${skillId} AND version = ${version}`;
  if (!row) return false;
  const steps = parse<SkillStep[]>(row.steps, []);
  await sql.transaction([
    ...replaceStepsQueries(sql, skillId, steps),
    sql`DELETE FROM skill_versions WHERE skill_id = ${skillId} AND version > ${version}`,
    sql`UPDATE personal_skills SET version = ${version}, updated_at = now() WHERE id = ${skillId}`,
  ]);
  return true;
}
