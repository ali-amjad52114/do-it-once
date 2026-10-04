// Neon repositories (server-only). Signatures are fixed by docs/CONTRACTS.md.
// Rows are mapped snake_case -> camelCase types from lib/contracts, timestamps as ISO strings.
import { randomUUID } from 'node:crypto';
import type {
  Approval,
  ApprovalStatus,
  Artifact,
  ArtifactType,
  EventType,
  ExecutionEvent,
  IncomingTrigger,
  RunResult,
  RunState,
  Skill,
  SkillDetail,
  SkillRun,
  SkillStep,
  TodayItem,
  TriggerState,
} from '@/lib/contracts';
import { getSql } from './db';
import { DEMO_TRIGGER_ID, DEMO_USER_ID } from './seed-data';

type Row = Record<string, any>;

// ── Mapping helpers

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
const json = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
};
const jsonParam = (v: unknown): string => JSON.stringify(v ?? {});

function mapSkill(r: Row): Skill {
  return {
    id: r.id,
    userId: r.user_id,
    title: r.title,
    description: r.description,
    status: r.status,
    version: Number(r.version),
    icon: r.icon,
    targetDomains: r.target_domains ?? [],
    startUrl: r.start_url,
    verification: json(r.verification, {}),
    valuePerYear: r.value_per_year === null ? null : Number(r.value_per_year),
    runCount: Number(r.run_count),
    successCount: Number(r.success_count),
    confidence: Number(r.confidence),
    lastSuccessAt: isoOrNull(r.last_success_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function mapStep(r: Row): SkillStep {
  return {
    id: r.id,
    skillId: r.skill_id,
    sequence: Number(r.sequence),
    intent: r.intent,
    actionType: r.action_type,
    targetDescription: r.target_description,
    inputSource: r.input_source,
    expectedBefore: r.expected_before,
    expectedAfter: r.expected_after,
    locatorHint: r.locator_hint,
    requiresApproval: Boolean(r.requires_approval),
    config: json(r.config, {}),
  };
}

function mapRun(r: Row): SkillRun {
  return {
    id: r.id,
    skillId: r.skill_id,
    userId: r.user_id,
    triggerId: r.trigger_id,
    state: r.state as RunState,
    currentStep: Number(r.current_step),
    browserSessionId: r.browser_session_id,
    liveViewUrl: r.live_view_url,
    startedAt: iso(r.started_at),
    completedAt: isoOrNull(r.completed_at),
    error: r.error,
    result: json<RunResult | null>(r.result, null),
  };
}

function mapEvent(r: Row): ExecutionEvent {
  return {
    id: r.id,
    runId: r.run_id,
    sequence: Number(r.sequence),
    type: r.type as EventType,
    message: r.message,
    metadata: json(r.metadata, {}),
    createdAt: iso(r.created_at),
  };
}

function mapApproval(r: Row): Approval {
  return {
    id: r.id,
    runId: r.run_id,
    stepSequence: Number(r.step_sequence),
    status: r.status,
    title: r.title,
    description: r.description,
    payload: json(r.payload, {}),
    createdAt: iso(r.created_at),
    decidedAt: isoOrNull(r.decided_at),
  };
}

function mapArtifact(r: Row): Artifact {
  return {
    id: r.id,
    runId: r.run_id,
    type: r.type as ArtifactType,
    mimeType: r.mime_type,
    location: r.location,
    metadata: json(r.metadata, {}),
    createdAt: iso(r.created_at),
  };
}

function mapTrigger(r: Row): IncomingTrigger {
  return {
    id: r.id,
    userId: r.user_id,
    source: r.source,
    subject: r.subject,
    payload: json(r.payload, {}),
    matchedSkillId: r.matched_skill_id,
    state: r.state as TriggerState,
    createdAt: iso(r.created_at),
  };
}

// ── Skills

export async function listSkills(userId: string): Promise<Skill[]> {
  const sql = getSql();
  const rows = await sql`SELECT * FROM personal_skills WHERE user_id = ${userId} AND status <> 'archived' ORDER BY created_at, title`;
  return rows.map(mapSkill);
}

export async function getSkill(skillId: string): Promise<SkillDetail | null> {
  const sql = getSql();
  const [skills, steps, triggers, prefs] = await sql.transaction(
    [
      sql`SELECT * FROM personal_skills WHERE id = ${skillId}`,
      sql`SELECT * FROM skill_steps WHERE skill_id = ${skillId} ORDER BY sequence`,
      sql`SELECT phrase FROM skill_triggers WHERE skill_id = ${skillId} ORDER BY created_at, phrase`,
      sql`SELECT key, value FROM skill_preferences WHERE skill_id = ${skillId} ORDER BY key`,
    ],
    { readOnly: true },
  );
  if (!skills[0]) return null;
  const preferences: Record<string, unknown> = {};
  for (const p of prefs) preferences[p.key] = json(p.value, null);
  return {
    ...mapSkill(skills[0]),
    steps: steps.map(mapStep),
    triggers: triggers.map((t) => t.phrase as string),
    preferences,
  };
}

/** Updates locatorHint (and nothing else) after a step succeeded with a new selector. */
export async function updateStepLocator(stepId: string, locatorHint: string): Promise<void> {
  const sql = getSql();
  await sql`UPDATE skill_steps SET locator_hint = ${locatorHint}, updated_at = now() WHERE id = ${stepId}`;
}

/** run_count += 1, success_count += success ? 1 : 0, last_success_at, confidence = success_count / run_count. */
export async function recordSkillOutcome(skillId: string, success: boolean): Promise<void> {
  const sql = getSql();
  const inc = success ? 1 : 0;
  await sql`
    UPDATE personal_skills SET
      run_count = run_count + 1,
      success_count = success_count + ${inc}::int,
      last_success_at = CASE WHEN ${success}::boolean THEN now() ELSE last_success_at END,
      confidence = (success_count + ${inc}::int)::double precision / (run_count + 1),
      updated_at = now()
    WHERE id = ${skillId}`;
}

// ── Runs

export async function createRun(input: { skillId: string; userId: string; triggerId?: string | null }): Promise<SkillRun> {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO skill_runs (skill_id, user_id, trigger_id, state, current_step)
    VALUES (${input.skillId}, ${input.userId}, ${input.triggerId ?? null}, 'queued', 0)
    RETURNING *`;
  return mapRun(rows[0]);
}

export async function getRun(runId: string): Promise<SkillRun | null> {
  const sql = getSql();
  const rows = await sql`SELECT * FROM skill_runs WHERE id = ${runId}`;
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function listRuns(userId: string, opts?: { skillId?: string; triggerId?: string; limit?: number }): Promise<SkillRun[]> {
  const sql = getSql();
  const limit = Math.max(1, Math.min(opts?.limit ?? 50, 500));
  const rows = await sql`
    SELECT * FROM skill_runs
    WHERE user_id = ${userId}
      AND (${opts?.skillId ?? null}::uuid IS NULL OR skill_id = ${opts?.skillId ?? null}::uuid)
      AND (${opts?.triggerId ?? null}::uuid IS NULL OR trigger_id = ${opts?.triggerId ?? null}::uuid)
    ORDER BY started_at DESC
    LIMIT ${limit}`;
  return rows.map(mapRun);
}

const RUN_COLUMNS: Record<string, string> = {
  state: 'state',
  currentStep: 'current_step',
  browserSessionId: 'browser_session_id',
  liveViewUrl: 'live_view_url',
  error: 'error',
  completedAt: 'completed_at',
  result: 'result',
};

export async function updateRun(
  runId: string,
  patch: Partial<Pick<SkillRun, 'state' | 'currentStep' | 'browserSessionId' | 'liveViewUrl' | 'error' | 'completedAt'>> & { result?: RunResult | null },
): Promise<SkillRun> {
  const sql = getSql();
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [runId];
  for (const [key, column] of Object.entries(RUN_COLUMNS)) {
    if (!(key in patch)) continue;
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === 'result') {
      params.push(value === null ? null : JSON.stringify(value));
      sets.push(`${column} = $${params.length}::jsonb`);
    } else {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
  }
  const rows = await sql.query(`UPDATE skill_runs SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  if (!rows[0]) throw new Error(`updateRun: run ${runId} not found`);
  return mapRun(rows[0]);
}

// ── Events (sequence assigned atomically per run)

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function appendEvent(runId: string, type: EventType, message: string, metadata?: Record<string, unknown>): Promise<ExecutionEvent> {
  const sql = getSql();
  const meta = jsonParam(metadata);
  for (let attempt = 0; ; attempt++) {
    try {
      // The per-run advisory lock serializes writers; the unique (run_id, sequence) constraint
      // plus the retry below is the safety net if two inserts still race.
      const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtext(${'execution_events:' + runId}))`,
        sql`
          INSERT INTO execution_events (run_id, sequence, type, message, metadata)
          SELECT ${runId}::uuid, COALESCE(MAX(sequence), 0) + 1, ${type}, ${message}, ${meta}::jsonb
          FROM execution_events WHERE run_id = ${runId}::uuid
          RETURNING *`,
      ]);
      return mapEvent(rows[0]);
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= 10) throw err;
      await sleep(5 + Math.random() * 20 * (attempt + 1));
    }
  }
}

export async function listEvents(runId: string, afterSequence?: number): Promise<ExecutionEvent[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM execution_events WHERE run_id = ${runId} AND sequence > ${afterSequence ?? 0}
    ORDER BY sequence`;
  return rows.map(mapEvent);
}

// ── Approvals

export async function createApproval(input: Omit<Approval, 'id' | 'status' | 'createdAt' | 'decidedAt'>): Promise<Approval> {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO approvals (run_id, step_sequence, status, title, description, payload)
    VALUES (${input.runId}, ${input.stepSequence}, 'pending', ${input.title}, ${input.description}, ${jsonParam(input.payload)}::jsonb)
    RETURNING *`;
  return mapApproval(rows[0]);
}

/** The pending approval if there is one, else the most recent. */
export async function getLatestApproval(runId: string): Promise<Approval | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM approvals WHERE run_id = ${runId}
    ORDER BY (status = 'pending') DESC, created_at DESC
    LIMIT 1`;
  return rows[0] ? mapApproval(rows[0]) : null;
}

export async function decideApproval(approvalId: string, status: Exclude<ApprovalStatus, 'pending'>): Promise<Approval> {
  const sql = getSql();
  const rows = await sql`
    UPDATE approvals SET status = ${status}, decided_at = now()
    WHERE id = ${approvalId}
    RETURNING *`;
  if (!rows[0]) throw new Error(`decideApproval: approval ${approvalId} not found`);
  return mapApproval(rows[0]);
}

// ── Artifacts (bytes stored base64 in artifacts.content_base64 when location is "neon:<id>")

export async function createArtifact(input: {
  runId: string;
  type: ArtifactType;
  mimeType: string;
  bytes?: Buffer;
  location?: string;
  metadata?: Record<string, unknown>;
}): Promise<Artifact> {
  const sql = getSql();
  const id = randomUUID();
  const location = input.location ?? `neon:${id}`;
  const content = input.bytes ? input.bytes.toString('base64') : null;
  const meta = { ...(input.metadata ?? {}), ...(input.bytes ? { sizeBytes: input.bytes.length } : {}) };
  const rows = await sql`
    INSERT INTO artifacts (id, run_id, type, mime_type, location, content_base64, metadata)
    VALUES (${id}, ${input.runId}, ${input.type}, ${input.mimeType}, ${location}, ${content}, ${jsonParam(meta)}::jsonb)
    RETURNING id, run_id, type, mime_type, location, metadata, created_at`;
  return mapArtifact(rows[0]);
}

export async function getArtifact(artifactId: string): Promise<(Artifact & { bytes: Buffer | null }) | null> {
  const sql = getSql();
  const rows = await sql`SELECT * FROM artifacts WHERE id = ${artifactId}`;
  if (!rows[0]) return null;
  const b64 = rows[0].content_base64 as string | null;
  return { ...mapArtifact(rows[0]), bytes: b64 ? Buffer.from(b64, 'base64') : null };
}

export async function listArtifacts(runId: string): Promise<Artifact[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT id, run_id, type, mime_type, location, metadata, created_at
    FROM artifacts WHERE run_id = ${runId} ORDER BY created_at`;
  return rows.map(mapArtifact);
}

// ── Triggers / Today

/** Pending and running triggers, plus ones done in the last 24 hours (dismissed are hidden). */
export async function listTodayItems(userId: string): Promise<TodayItem[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT t.*, s.title AS skill_title,
      (SELECT r.id FROM skill_runs r WHERE r.trigger_id = t.id ORDER BY r.started_at DESC LIMIT 1) AS latest_run_id
    FROM incoming_triggers t
    LEFT JOIN personal_skills s ON s.id = t.matched_skill_id
    WHERE t.user_id = ${userId}
      AND (t.state IN ('pending', 'running') OR (t.state = 'done' AND t.updated_at > now() - interval '24 hours'))
    ORDER BY CASE t.state WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, t.created_at DESC`;
  return rows.map((r) => {
    const payload = json<Record<string, unknown>>(r.payload, {});
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return {
      triggerId: r.id,
      title: str(payload.title) ?? r.subject,
      merchant: str(payload.merchant),
      amount: str(payload.amount),
      dueLabel: str(payload.dueLabel),
      matchedSkill: r.matched_skill_id ? { id: r.matched_skill_id, title: r.skill_title } : null,
      state: r.state as TriggerState,
      latestRunId: r.latest_run_id ?? null,
    };
  });
}

export async function getTrigger(triggerId: string): Promise<IncomingTrigger | null> {
  const sql = getSql();
  const rows = await sql`SELECT * FROM incoming_triggers WHERE id = ${triggerId}`;
  return rows[0] ? mapTrigger(rows[0]) : null;
}

export async function setTriggerState(triggerId: string, state: TriggerState): Promise<void> {
  const sql = getSql();
  await sql`UPDATE incoming_triggers SET state = ${state}, updated_at = now() WHERE id = ${triggerId}`;
}

// ── Demo

/**
 * Same as `npm run db:seed -- --reset`: the Today trigger is pending again and no run is attached to it.
 * Real history is KEPT: past runs and the skill's run/success counts stay (they only come from actual runs).
 */
export async function resetDemoState(): Promise<void> {
  const sql = getSql();
  await sql.transaction([
    sql`
      UPDATE skill_runs SET state = 'stopped', completed_at = now(), error = 'Reset before finishing'
      WHERE user_id = ${DEMO_USER_ID} AND state NOT IN ('succeeded', 'failed', 'stopped')`,
    sql`UPDATE skill_runs SET trigger_id = NULL WHERE trigger_id = ${DEMO_TRIGGER_ID}`,
    sql`UPDATE incoming_triggers SET state = 'pending', updated_at = now() WHERE id = ${DEMO_TRIGGER_ID}`,
  ]);
}

/** `npm run db:seed -- --wipe`: delete every demo run and zero the counters (fresh start, no history). */
export async function wipeDemoHistory(): Promise<void> {
  const sql = getSql();
  await sql.transaction([
    // Cascades to execution_events, approvals and artifacts.
    sql`DELETE FROM skill_runs WHERE user_id = ${DEMO_USER_ID}`,
    sql`
      UPDATE personal_skills SET run_count = 0, success_count = 0, confidence = 0, last_success_at = NULL, updated_at = now()
      WHERE user_id = ${DEMO_USER_ID}`,
    sql`UPDATE incoming_triggers SET state = 'pending', updated_at = now() WHERE id = ${DEMO_TRIGGER_ID}`,
  ]);
}
