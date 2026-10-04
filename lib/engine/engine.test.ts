import { describe, expect, it } from 'vitest';
import type {
  ActionOutcome,
  Approval,
  Artifact,
  BrowserAdapter,
  ElementTarget,
  ExecutionEvent,
  PageState,
  SkillDetail,
  SkillRun,
  SkillStep,
  TriggerState,
  VerificationResult,
  VerificationSpec,
} from '@/lib/contracts';
import { createRunEngine, type EngineRepo } from '@/lib/engine/engine';

// ───────────── Fixtures ─────────────

const ORIGIN = 'https://demo.example.test';
const SKILL_ID = 'skill-cancel';
const USER_ID = 'user-1';
const TRIGGER_ID = 'trigger-1';

function step(
  sequence: number,
  intent: string,
  actionType: SkillStep['actionType'],
  opts: Partial<SkillStep> & { matchText?: string; approval?: { title: string; description: string } } = {},
): SkillStep {
  const { matchText, approval, ...rest } = opts;
  return {
    id: `step-${sequence}`,
    skillId: SKILL_ID,
    sequence,
    intent,
    actionType,
    targetDescription: null,
    inputSource: null,
    expectedBefore: null,
    expectedAfter: null,
    locatorHint: null,
    requiresApproval: false,
    config: { ...(matchText ? { matchText } : {}), ...(approval ? { approval } : {}) },
    ...rest,
  };
}

function seededSkill(): SkillDetail {
  return {
    id: SKILL_ID,
    userId: USER_ID,
    title: 'Cancel subscription',
    description: 'Cancel a membership',
    status: 'active',
    version: 1,
    icon: 'subscription',
    targetDomains: ['demo.example.test'],
    startUrl: `${ORIGIN}/account`,
    verification: {
      anyOf: [
        { type: 'text_contains', value: 'Membership canceled' },
        { type: 'text_contains', value: 'Renews: No' },
      ],
      allOf: [{ type: 'url_matches', value: '/account/membership' }],
    },
    valuePerYear: 228,
    runCount: 3,
    successCount: 3,
    confidence: 1,
    lastSuccessAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    triggers: ['cancel subscription'],
    preferences: { confirm_before_cancel: true, decline_retention_offers: true },
    steps: [
      step(1, 'Open my Lumen+ account', 'navigate', { inputSource: 'url:/account', expectedAfter: 'Welcome back' }),
      step(2, 'Open billing settings', 'click', {
        targetDescription: 'Billing link in the account sidebar',
        matchText: 'Billing',
        expectedAfter: 'Manage membership',
        locatorHint: 'role=link[name="Billing"]',
      }),
      step(3, 'Open membership management', 'click', {
        targetDescription: 'Manage membership button',
        matchText: 'Manage membership',
        expectedAfter: 'Cancel membership',
        locatorHint: 'role=link[name="Manage membership"]',
      }),
      step(4, 'Start cancellation', 'click', {
        targetDescription: 'Cancel membership link',
        matchText: 'Cancel membership',
        expectedAfter: 'Before you go',
        locatorHint: 'role=link[name="Cancel membership"]',
      }),
      step(5, 'Decline the retention offer', 'click', {
        targetDescription: 'No thanks, continue to cancel button',
        matchText: 'No thanks, continue to cancel',
        expectedAfter: 'Confirm cancellation',
        locatorHint: 'role=link[name="No thanks, continue to cancel"]',
      }),
      step(6, 'Confirm the cancellation', 'click', {
        targetDescription: 'Confirm cancellation button',
        matchText: 'Confirm cancellation',
        expectedAfter: 'Membership canceled',
        locatorHint: 'role=button[name="Confirm cancellation"]',
        requiresApproval: true,
        approval: {
          title: 'Cancel $19/month membership?',
          description: 'Agent reached the final cancellation screen. This is irreversible.',
        },
      }),
    ],
  };
}

// ───────────── In-memory repo ─────────────

function createFakeRepo(skill: SkillDetail) {
  const runs = new Map<string, SkillRun>();
  const events: ExecutionEvent[] = [];
  const approvals: Approval[] = [];
  const artifacts: Artifact[] = [];
  const triggers = new Map<string, TriggerState>([[TRIGGER_ID, 'pending']]);
  const locatorUpdates: Array<{ stepId: string; locatorHint: string }> = [];
  const outcomes: boolean[] = [];
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  const stamp = () => new Date(Date.UTC(2026, 9, 4, 12, 0, n)).toISOString();

  const repo: EngineRepo = {
    async getSkill(skillId) {
      return skillId === skill.id ? structuredClone(skill) : null;
    },
    async updateStepLocator(stepId, locatorHint) {
      locatorUpdates.push({ stepId, locatorHint });
      const s = skill.steps.find((x) => x.id === stepId);
      if (s) s.locatorHint = locatorHint;
    },
    async recordSkillOutcome(_skillId, success) {
      outcomes.push(success);
    },
    async createRun(input) {
      const run: SkillRun = {
        id: id('run'),
        skillId: input.skillId,
        userId: input.userId,
        triggerId: input.triggerId ?? null,
        state: 'queued',
        currentStep: 0,
        browserSessionId: null,
        liveViewUrl: null,
        startedAt: stamp(),
        completedAt: null,
        error: null,
        result: null,
      };
      runs.set(run.id, run);
      return { ...run };
    },
    async getRun(runId) {
      const r = runs.get(runId);
      return r ? { ...r } : null;
    },
    async listRuns() {
      return [...runs.values()];
    },
    async updateRun(runId, patch) {
      const r = runs.get(runId);
      if (!r) throw new Error('no run');
      Object.assign(r, patch);
      return { ...r };
    },
    async appendEvent(runId, type, message, metadata = {}) {
      const ev: ExecutionEvent = {
        id: id('ev'),
        runId,
        sequence: events.filter((e) => e.runId === runId).length + 1,
        type,
        message,
        metadata,
        createdAt: stamp(),
      };
      events.push(ev);
      return ev;
    },
    async createApproval(input) {
      const a: Approval = { ...input, id: id('appr'), status: 'pending', createdAt: stamp(), decidedAt: null };
      approvals.push(a);
      return { ...a };
    },
    async getLatestApproval(runId) {
      const list = approvals.filter((a) => a.runId === runId);
      return list.length ? { ...list[list.length - 1] } : null;
    },
    async decideApproval(approvalId, status) {
      const a = approvals.find((x) => x.id === approvalId)!;
      a.status = status;
      a.decidedAt = stamp();
      return { ...a };
    },
    async createArtifact(input) {
      const a: Artifact = {
        id: id('art'),
        runId: input.runId,
        type: input.type,
        mimeType: input.mimeType,
        location: 'neon:x',
        metadata: input.metadata ?? {},
        createdAt: stamp(),
      };
      artifacts.push(a);
      return a;
    },
    async setTriggerState(triggerId, state) {
      triggers.set(triggerId, state);
    },
  } as EngineRepo;

  return { repo, runs, events, approvals, artifacts, triggers, locatorUpdates, outcomes };
}

// ───────────── Scripted fake browser (models the Lumen+ site) ─────────────

class BrowserSessionGoneError extends Error {
  constructor(id: string) {
    super(`Browser session ${id} is gone`);
    this.name = 'BrowserSessionGoneError';
  }
}

interface SitePage {
  title: string;
  text: () => string;
  links: Record<string, string>; // matchText -> path
}

function createFakeBrowser(options: { usedLocators?: Record<string, string>; brokenLink?: string } = {}) {
  let canceled = false;
  const sessions = new Map<string, { path: string }>();
  const gone = new Set<string>();
  const closed: string[] = [];
  const opened: string[] = [];
  const calls: string[] = [];
  let n = 0;

  const site: Record<string, SitePage> = {
    '/account': {
      title: 'Account · Lumen+',
      text: () => 'Welcome back, Ali Overview Profile Billing Devices',
      links: { Billing: '/account/billing' },
    },
    '/account/billing': {
      title: 'Billing · Lumen+',
      text: () => `Payment method Visa •••• 4242 Lumen+ Premium · $19/month · ${canceled ? 'Renews: No' : 'Renews tomorrow (Oct 5, 2026)'} Manage membership`,
      links: { 'Manage membership': '/account/membership' },
    },
    '/account/membership': {
      title: 'Membership · Lumen+',
      text: () =>
        canceled
          ? 'Membership canceled Renews: No Access ends on Oct 5, 2026'
          : 'Lumen+ Premium $19/month Next renewal: Oct 5, 2026 Change plan Cancel membership',
      links: { 'Cancel membership': '/account/membership/cancel' },
    },
    '/account/membership/cancel': {
      title: 'Before you go · Lumen+',
      text: () => 'Before you go… 50% off for 3 months Accept offer No thanks, continue to cancel',
      links: { 'No thanks, continue to cancel': '/account/membership/cancel/confirm' },
    },
    '/account/membership/cancel/confirm': {
      title: 'Confirm cancellation · Lumen+',
      text: () => "Confirm cancellation $19/month You'll keep access until Oct 5, 2026 Confirm cancellation",
      links: { 'Confirm cancellation': '/account/membership' },
    },
  };

  const pageOf = (path: string): PageState => {
    const p = site[path.split('?')[0]];
    return p ? { url: ORIGIN + path, title: p.title, text: p.text() } : { url: ORIGIN + path, title: 'Not found', text: 'Not found' };
  };
  const live = (sid: string) => {
    if (gone.has(sid) || !sessions.has(sid)) throw new BrowserSessionGoneError(sid);
    return sessions.get(sid)!;
  };

  const adapter: BrowserAdapter = {
    async open(opts) {
      const sid = `sess-${++n}`;
      opened.push(sid);
      sessions.set(sid, { path: opts?.startUrl ? new URL(opts.startUrl).pathname : '/' });
      return { id: sid, liveViewUrl: `https://live.example/${sid}` };
    },
    async goto(sid, url): Promise<ActionOutcome> {
      calls.push(`goto ${url}`);
      const s = live(sid);
      const u = new URL(url);
      s.path = u.pathname + u.search;
      return { ok: true, usedLocator: null, page: pageOf(s.path) };
    },
    async click(sid, target: ElementTarget): Promise<ActionOutcome> {
      calls.push(`click ${target.matchText}`);
      const s = live(sid);
      const p = site[s.path.split('?')[0]];
      const key = target.matchText ?? '';
      const dest = p?.links[key];
      if (!dest) return { ok: false, usedLocator: null, page: pageOf(s.path), error: `Couldn't find "${key}"` };
      if (key !== options.brokenLink) {
        if (key === 'Confirm cancellation') canceled = true;
        s.path = key === 'Confirm cancellation' ? '/account/membership?canceled=1' : dest;
      }
      const usedLocator = options.usedLocators?.[key] ?? target.locatorHint ?? null;
      return { ok: true, usedLocator, page: pageOf(s.path) };
    },
    async type(sid) {
      return { ok: true, usedLocator: null, page: pageOf(live(sid).path) };
    },
    async select(sid) {
      return { ok: true, usedLocator: null, page: pageOf(live(sid).path) };
    },
    async waitForText(sid, text): Promise<ActionOutcome> {
      calls.push(`wait ${text}`);
      const page = pageOf(live(sid).path);
      return page.text.includes(text) ? { ok: true, usedLocator: null, page } : { ok: false, usedLocator: null, page, error: 'timeout' };
    },
    async readPage(sid) {
      return pageOf(live(sid).path);
    },
    async screenshot(sid) {
      live(sid);
      return Buffer.from('png');
    },
    async close(sid) {
      closed.push(sid);
      sessions.delete(sid);
    },
  };

  return {
    adapter,
    closed,
    opened,
    calls,
    kill: (sid: string) => gone.add(sid),
    setCanceled: (v: boolean) => (canceled = v),
    isCanceled: () => canceled,
  };
}

// Simple stand-ins for B6's modules (the real ones are developed in parallel).
function fakeVerify(spec: VerificationSpec, page: PageState): VerificationResult {
  const check = (r: NonNullable<VerificationSpec['allOf']>[number]) =>
    r.type === 'text_contains'
      ? page.text.includes(r.value)
      : r.type === 'text_absent'
        ? !page.text.includes(r.value)
        : new RegExp(r.value).test(page.url);
  const matched: string[] = [];
  const failedRules = [];
  for (const r of spec.allOf ?? []) (check(r) ? matched.push(r.value) : failedRules.push(r));
  const any = spec.anyOf ?? [];
  const anyHits = any.filter(check);
  matched.unshift(...anyHits.map((r) => r.value));
  if (any.length && !anyHits.length) failedRules.push(...any);
  return { passed: failedRules.length === 0, matched, failedRules };
}

function fakeExtract(page: PageState): Approval['payload'] {
  return { price: page.text.match(/\$\d+\/month/)?.[0], merchant: 'Lumen+' };
}

function setup(browserOpts?: Parameters<typeof createFakeBrowser>[0], verify = fakeVerify) {
  const skill = seededSkill();
  const db = createFakeRepo(skill);
  const br = createFakeBrowser(browserOpts);
  const engine = createRunEngine({
    repo: db.repo,
    browser: br.adapter,
    verify,
    extract: fakeExtract,
    now: () => new Date('2026-10-04T12:00:00.000Z'),
  });
  const types = (runId: string) => db.events.filter((e) => e.runId === runId).map((e) => e.type);
  const run = (runId: string) => db.runs.get(runId)!;
  return { skill, db, br, engine, types, run };
}

const STEP_PAIRS = (count: number) => Array.from({ length: count }, () => ['step.started', 'step.succeeded']).flat();

// ───────────── Tests ─────────────

describe('run engine', () => {
  it('runs to the approval step, then approve → verified success with the exact event order', async () => {
    const { engine, db, br, types, run } = setup();
    const { runId } = await engine.startRun({ skillId: SKILL_ID, userId: USER_ID, triggerId: TRIGGER_ID });
    expect(db.triggers.get(TRIGGER_ID)).toBe('running');
    await engine.whenIdle(runId);

    expect(run(runId).state).toBe('waiting_approval');
    expect(run(runId).currentStep).toBe(6);
    expect(run(runId).liveViewUrl).toBe('https://live.example/sess-1');
    expect(br.closed).toEqual([]);
    expect(br.isCanceled()).toBe(false);
    expect(types(runId)).toEqual(['run.started', 'browser.opened', ...STEP_PAIRS(5), 'approval.requested']);
    const requested = db.events.find((e) => e.type === 'approval.requested')!;
    expect(requested.message).toBe('Waiting for your approval: Cancel $19/month membership?');
    expect(db.approvals[0]).toMatchObject({ stepSequence: 6, status: 'pending', title: 'Cancel $19/month membership?' });
    expect(db.approvals[0].payload).toMatchObject({ price: '$19/month', pageUrl: `${ORIGIN}/account/membership/cancel/confirm` });
    // navigate resolved against the startUrl origin
    expect(br.calls[0]).toBe(`goto ${ORIGIN}/account`);
    const billing = db.events.find((e) => e.type === 'step.succeeded' && e.metadata.stepSequence === 2)!;
    expect(billing.metadata).toEqual({ stepSequence: 2, url: `${ORIGIN}/account/billing`, usedLocator: 'role=link[name="Billing"]' });
    expect(db.events.find((e) => e.type === 'step.started' && e.metadata.stepSequence === 2)!.message).toBe('Open billing settings');

    await engine.approve(runId);
    await engine.whenIdle(runId);

    const r = run(runId);
    expect(r.state).toBe('succeeded');
    expect(r.completedAt).not.toBeNull();
    expect(types(runId)).toEqual([
      'run.started',
      'browser.opened',
      ...STEP_PAIRS(5),
      'approval.requested',
      'approval.granted',
      'step.started',
      'step.succeeded',
      'verify.started',
      'artifact.saved',
      'verify.passed',
      'run.succeeded',
    ]);
    expect(db.events.find((e) => e.type === 'verify.passed')!.message).toBe('Verified: Membership canceled');
    const saved = db.events.find((e) => e.type === 'artifact.saved')!;
    expect(saved.metadata).toEqual({ artifactId: db.artifacts[0].id });
    expect(r.result).toMatchObject({
      success: true,
      summary: 'Lumen+ membership canceled. Verified on the website.',
      valuePerYear: 228,
      screenshotArtifactId: db.artifacts[0].id,
      finalUrl: `${ORIGIN}/account/membership?canceled=1`,
    });
    expect(db.approvals[0].status).toBe('approved');
    expect(db.outcomes).toEqual([true]);
    expect(db.triggers.get(TRIGGER_ID)).toBe('done');
    expect(br.closed).toEqual(['sess-1']);
  });

  it('stop while waiting: denies the approval, stops, closes the browser, trigger back to pending', async () => {
    const { engine, db, br, types, run } = setup();
    const { runId } = await engine.startRun({ skillId: SKILL_ID, userId: USER_ID, triggerId: TRIGGER_ID });
    await engine.whenIdle(runId);
    expect(run(runId).state).toBe('waiting_approval');

    await engine.stop(runId);
    await engine.whenIdle(runId);

    expect(run(runId).state).toBe('stopped');
    expect(db.approvals[0].status).toBe('denied');
    expect(types(runId).slice(-2)).toEqual(['approval.denied', 'run.stopped']);
    expect(br.closed).toEqual(['sess-1']);
    expect(db.triggers.get(TRIGGER_ID)).toBe('pending');
    expect(br.isCanceled()).toBe(false);
    await expect(engine.approve(runId)).rejects.toThrow(/not waiting for approval/);
  });

  it('fails the run when the expected text never appears after a step', async () => {
    const { engine, db, br, types, run } = setup({ brokenLink: 'Manage membership' });
    const { runId } = await engine.startRun({ skillId: SKILL_ID, userId: USER_ID, triggerId: TRIGGER_ID });
    await engine.whenIdle(runId);

    const r = run(runId);
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/Couldn't open membership management: expected to see "Cancel membership"/);
    expect(types(runId)).toEqual(['run.started', 'browser.opened', ...STEP_PAIRS(2), 'step.started', 'step.failed', 'run.failed']);
    expect(br.calls).toContain('wait Cancel membership');
    expect(br.closed).toEqual(['sess-1']);
    expect(db.outcomes).toEqual([false]);
    expect(db.triggers.get(TRIGGER_ID)).toBe('pending');
  });

  it('fails the run when verification fails', async () => {
    const neverPasses = (): VerificationResult => ({
      passed: false,
      matched: [],
      failedRules: [{ type: 'text_contains', value: 'Membership canceled' }],
    });
    const { engine, db, br, types, run } = setup(undefined, neverPasses);
    const { runId } = await engine.startRun({ skillId: SKILL_ID, userId: USER_ID });
    await engine.whenIdle(runId);
    await engine.approve(runId);
    await engine.whenIdle(runId);

    const r = run(runId);
    expect(r.state).toBe('failed');
    expect(r.result?.success).toBe(false);
    expect(r.result?.screenshotArtifactId).toBe(db.artifacts[0].id);
    expect(types(runId).slice(-4)).toEqual(['verify.started', 'artifact.saved', 'verify.failed', 'run.failed']);
    expect(db.outcomes).toEqual([false]);
    expect(br.closed).toEqual(['sess-1']);
  });

  it('persists a new locator when the one that worked differs from the hint', async () => {
    const { engine, db, run } = setup({ usedLocators: { Billing: 'text=Billing' } });
    const { runId } = await engine.startRun({ skillId: SKILL_ID, userId: USER_ID });
    await engine.whenIdle(runId);

    expect(run(runId).state).toBe('waiting_approval');
    expect(db.locatorUpdates).toEqual([{ stepId: 'step-2', locatorHint: 'text=Billing' }]);
    const ev = db.events.find((e) => e.type === 'step.succeeded' && e.metadata.stepSequence === 2)!;
    expect(ev.metadata.usedLocator).toBe('text=Billing');
  });

  it('approve after the browser session is gone: reopens, catches up, then succeeds', async () => {
    const { engine, db, br, types, run } = setup();
    const { runId } = await engine.startRun({ skillId: SKILL_ID, userId: USER_ID, triggerId: TRIGGER_ID });
    await engine.whenIdle(runId);
    br.kill('sess-1');

    await engine.approve(runId);
    await engine.whenIdle(runId);

    const r = run(runId);
    expect(r.state).toBe('succeeded');
    expect(r.browserSessionId).toBe('sess-2');
    expect(br.opened).toEqual(['sess-1', 'sess-2']);
    const log = db.events.find((e) => e.type === 'log')!;
    expect(log.message).toBe('Browser session expired — reopening and catching up');
    expect(types(runId).slice(-9)).toEqual([
      'approval.granted',
      'step.started',
      'log',
      'browser.opened',
      'step.succeeded',
      'verify.started',
      'artifact.saved',
      'verify.passed',
      'run.succeeded',
    ]);
    expect(br.isCanceled()).toBe(true);
    // Fast replay re-visited the earlier steps on the new session before confirming.
    expect(br.calls.filter((c) => c === 'click No thanks, continue to cancel')).toHaveLength(2);
    expect(br.calls.filter((c) => c === 'click Confirm cancellation').length).toBeGreaterThanOrEqual(1);
  });

  it('approve after a server restart (fresh engine) continues the run', async () => {
    const first = setup();
    const { runId } = await first.engine.startRun({ skillId: SKILL_ID, userId: USER_ID });
    await first.engine.whenIdle(runId);
    first.br.kill('sess-1');
    const restarted = createRunEngine({
      repo: first.db.repo,
      browser: first.br.adapter,
      verify: fakeVerify,
      extract: fakeExtract,
    });
    await restarted.approve(runId);
    await restarted.whenIdle(runId);
    expect(first.run(runId).state).toBe('succeeded');
  });

  it('guards against double execution of approve, and approve while the run is executing', async () => {
    const { engine, br, types, run } = setup();
    const { runId } = await engine.startRun({ skillId: SKILL_ID, userId: USER_ID });
    // Run is executing in the background: approve is a no-op instead of starting a second loop.
    await engine.approve(runId);
    await engine.whenIdle(runId);
    expect(run(runId).state).toBe('waiting_approval');
    expect(types(runId).filter((t) => t === 'run.started')).toHaveLength(1);

    await Promise.all([engine.approve(runId), engine.approve(runId)]);
    await engine.whenIdle(runId);

    expect(run(runId).state).toBe('succeeded');
    expect(types(runId).filter((t) => t === 'approval.granted')).toHaveLength(1);
    expect(types(runId).filter((t) => t === 'run.succeeded')).toHaveLength(1);
    expect(br.calls.filter((c) => c === 'click Confirm cancellation')).toHaveLength(1);
  });

  it('turns unexpected errors into a failed run with a readable message', async () => {
    const { engine, db, run, br } = setup();
    db.repo.createApproval = async () => {
      throw new Error('database unavailable');
    };
    const { runId } = await engine.startRun({ skillId: SKILL_ID, userId: USER_ID });
    await engine.whenIdle(runId);
    expect(run(runId).state).toBe('failed');
    expect(run(runId).error).toBe('Something went wrong: database unavailable');
    expect(db.events.at(-1)!.type).toBe('run.failed');
    expect(br.closed).toEqual(['sess-1']);
    expect(db.outcomes).toEqual([false]);
  });
});
