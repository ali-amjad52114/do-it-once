// Integration tests against the real Neon DB. Run with: RUN_DB_TESTS=1 npx vitest run lib/neon
// Requires `npm run db:migrate && npm run db:seed` first. Creates its own trigger + runs and deletes them.
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSql } from './db';
import * as repo from './repo';
import { CANCEL_SKILL_ID, DEMO_USER_ID } from './seed-data';

const enabled = process.env.RUN_DB_TESTS === '1';

describe.skipIf(!enabled)('lib/neon/repo (Neon integration)', () => {
  const runIds: string[] = [];
  let triggerId = '';
  let skillBefore: { runCount: number; successCount: number; lastSuccessAt: string | null } | null = null;

  beforeAll(async () => {
    const sql = getSql();
    const [t] = await sql`
      INSERT INTO incoming_triggers (user_id, source, subject, payload, matched_skill_id, state)
      VALUES (${DEMO_USER_ID}, 'manual', 'repo.test trigger',
        ${JSON.stringify({ merchant: 'TestCo', amount: '$1/month', dueLabel: 'Renews today' })}::jsonb, ${CANCEL_SKILL_ID}, 'pending')
      RETURNING id`;
    triggerId = t.id;
    const s = await repo.getSkill(CANCEL_SKILL_ID);
    skillBefore = s && { runCount: s.runCount, successCount: s.successCount, lastSuccessAt: s.lastSuccessAt };
  });

  afterAll(async () => {
    const sql = getSql();
    if (runIds.length) await sql`DELETE FROM skill_runs WHERE id = ANY(${runIds}::uuid[])`;
    if (triggerId) await sql`DELETE FROM incoming_triggers WHERE id = ${triggerId}`;
    if (skillBefore) {
      await sql`
        UPDATE personal_skills SET run_count = ${skillBefore.runCount}, success_count = ${skillBefore.successCount},
          confidence = ${skillBefore.runCount ? skillBefore.successCount / skillBefore.runCount : 0},
          last_success_at = ${skillBefore.lastSuccessAt}
        WHERE id = ${CANCEL_SKILL_ID}`;
    }
  });

  it('getSkill returns the seeded Cancel skill with ordered steps', async () => {
    const skill = await repo.getSkill(CANCEL_SKILL_ID);
    expect(skill).not.toBeNull();
    expect(skill!.title).toBe('Cancel subscription');
    expect(skill!.steps.map((s) => s.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(skill!.steps[0]).toMatchObject({ actionType: 'navigate', inputSource: 'url:/account', expectedAfter: 'Welcome back' });
    expect(skill!.steps[5].requiresApproval).toBe(true);
    expect(skill!.steps[5].config.approval?.title).toBe('Cancel $19/month membership?');
    expect(skill!.triggers).toContain('stop paying for this');
    expect(skill!.preferences).toEqual({ confirm_before_cancel: true, decline_retention_offers: true });
    expect(skill!.verification.anyOf).toHaveLength(2);
    expect(typeof skill!.createdAt).toBe('string');
    const all = await repo.listSkills(DEMO_USER_ID);
    expect(all.map((s) => s.title)).toEqual(expect.arrayContaining(['Cancel subscription', 'Return online order', 'Book haircut', 'Renew registration']));
  });

  it('creates, reads, lists and updates a run', async () => {
    const run = await repo.createRun({ skillId: CANCEL_SKILL_ID, userId: DEMO_USER_ID, triggerId });
    runIds.push(run.id);
    expect(run).toMatchObject({ state: 'queued', currentStep: 0, triggerId, result: null, completedAt: null });
    expect(new Date(run.startedAt).toISOString()).toBe(run.startedAt);

    const updated = await repo.updateRun(run.id, { state: 'running', currentStep: 2, browserSessionId: 'sess_1', liveViewUrl: 'https://live/x' });
    expect(updated).toMatchObject({ state: 'running', currentStep: 2, browserSessionId: 'sess_1', liveViewUrl: 'https://live/x' });

    const result = { success: true, summary: 'done', evidenceText: ['Membership canceled'], finalUrl: 'https://x/account/membership', screenshotArtifactId: null, verifiedAt: new Date().toISOString(), valuePerYear: 228 };
    const done = await repo.updateRun(run.id, { state: 'succeeded', result, completedAt: new Date().toISOString(), error: null });
    expect(done.result).toEqual(result);
    expect(done.completedAt).not.toBeNull();
    expect(done.browserSessionId).toBe('sess_1');

    expect((await repo.getRun(run.id))?.state).toBe('succeeded');
    expect(await repo.getRun('00000000-0000-4000-8000-00000000dead')).toBeNull();
    const listed = await repo.listRuns(DEMO_USER_ID, { triggerId, limit: 5 });
    expect(listed.map((r) => r.id)).toContain(run.id);
    const bySkill = await repo.listRuns(DEMO_USER_ID, { skillId: CANCEL_SKILL_ID, limit: 50 });
    expect(bySkill.every((r) => r.skillId === CANCEL_SKILL_ID)).toBe(true);
  });

  it('appendEvent assigns unique, contiguous sequences under concurrency', async () => {
    const run = await repo.createRun({ skillId: CANCEL_SKILL_ID, userId: DEMO_USER_ID });
    runIds.push(run.id);
    const n = 12;
    const events = await Promise.all(
      Array.from({ length: n }, (_, i) => repo.appendEvent(run.id, 'log', `event ${i}`, { i })),
    );
    expect(events.map((e) => e.sequence).sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    const listed = await repo.listEvents(run.id);
    expect(listed.map((e) => e.sequence)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    expect(listed[0].metadata).toHaveProperty('i');
    const after = await repo.listEvents(run.id, 10);
    expect(after.map((e) => e.sequence)).toEqual([11, 12]);
  }, 30_000);

  it('creates and decides approvals', async () => {
    const run = await repo.createRun({ skillId: CANCEL_SKILL_ID, userId: DEMO_USER_ID });
    runIds.push(run.id);
    expect(await repo.getLatestApproval(run.id)).toBeNull();
    const a = await repo.createApproval({ runId: run.id, stepSequence: 6, title: 'Cancel $19/month membership?', description: 'Irreversible.', payload: { price: '$19/month', merchant: 'Lumen+' } });
    expect(a).toMatchObject({ status: 'pending', stepSequence: 6, decidedAt: null, payload: { price: '$19/month' } });
    expect((await repo.getLatestApproval(run.id))?.id).toBe(a.id);
    const decided = await repo.decideApproval(a.id, 'approved');
    expect(decided.status).toBe('approved');
    expect(decided.decidedAt).not.toBeNull();
    expect((await repo.getLatestApproval(run.id))?.status).toBe('approved');
  });

  it('round-trips artifact bytes', async () => {
    const run = await repo.createRun({ skillId: CANCEL_SKILL_ID, userId: DEMO_USER_ID });
    runIds.push(run.id);
    const bytes = Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 256));
    const art = await repo.createArtifact({ runId: run.id, type: 'screenshot', mimeType: 'image/png', bytes, metadata: { step: 6 } });
    expect(art.location).toBe(`neon:${art.id}`);
    const got = await repo.getArtifact(art.id);
    expect(got?.bytes?.equals(bytes)).toBe(true);
    expect(got?.mimeType).toBe('image/png');
    const ext = await repo.createArtifact({ runId: run.id, type: 'file', mimeType: 'text/plain', location: 'https://example.com/x.txt' });
    expect((await repo.getArtifact(ext.id))?.bytes).toBeNull();
    expect((await repo.listArtifacts(run.id)).map((x) => x.id)).toEqual([art.id, ext.id]);
  });

  it('listTodayItems returns the trigger with matched skill and latest run', async () => {
    await repo.setTriggerState(triggerId, 'running');
    const items = await repo.listTodayItems(DEMO_USER_ID);
    const item = items.find((i) => i.triggerId === triggerId);
    expect(item).toMatchObject({
      title: 'repo.test trigger', merchant: 'TestCo', amount: '$1/month', dueLabel: 'Renews today', state: 'running',
      matchedSkill: { id: CANCEL_SKILL_ID, title: 'Cancel subscription' },
    });
    expect(item?.latestRunId).toBe(runIds[0]);
    expect((await repo.getTrigger(triggerId))?.state).toBe('running');
    await repo.setTriggerState(triggerId, 'dismissed');
    expect((await repo.listTodayItems(DEMO_USER_ID)).some((i) => i.triggerId === triggerId)).toBe(false);
  });

  it('recordSkillOutcome updates counts and confidence', async () => {
    const before = (await repo.getSkill(CANCEL_SKILL_ID))!;
    await repo.recordSkillOutcome(CANCEL_SKILL_ID, false);
    const afterFail = (await repo.getSkill(CANCEL_SKILL_ID))!;
    expect(afterFail.runCount).toBe(before.runCount + 1);
    expect(afterFail.successCount).toBe(before.successCount);
    expect(afterFail.confidence).toBeCloseTo(before.successCount / (before.runCount + 1));
    await repo.recordSkillOutcome(CANCEL_SKILL_ID, true);
    const afterOk = (await repo.getSkill(CANCEL_SKILL_ID))!;
    expect(afterOk.successCount).toBe(before.successCount + 1);
    expect(afterOk.lastSuccessAt && Date.parse(afterOk.lastSuccessAt)).toBeGreaterThan(Date.now() - 60_000);
  });
});
