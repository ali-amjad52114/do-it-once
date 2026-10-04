// Mock backend for the dashboard (`?mock=1`). Simulates the full S1 storyboard in the browser:
// steps tick ~1.2s each → waiting_approval → Approve → resumed → verifying → succeeded.
// The run timeline is derived from timestamps kept in sessionStorage, so a page refresh while
// waiting for approval restores exactly the same state (like the real backend does).
// `?mock=fail` makes step 4 fail so the failed state can be designed too.
import type {
  Approval,
  EventType,
  ExecutionEvent,
  RunResult,
  RunState,
  RunView,
  SkillDetail,
  SkillRun,
  SkillStep,
  SkillSummary,
  TodayItem,
} from '@/lib/contracts';
import { DEMO_USER_ID } from '@/lib/contracts';

const STORAGE_KEY = 'dio.mock.run.v1';
const STEP_MS = 1200;
const FIRST_STEP_AT = 900;

const iso = (ms: number) => new Date(ms).toISOString();
const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// ───────────────────────── Seed data ─────────────────────────

const CANCEL_ID = 'mock-skill-cancel';
const TRIGGER_ID = 'mock-trigger-lumen';
const MOCK_SITE = 'https://lumen-plus.demo';

function step(
  sequence: number,
  intent: string,
  actionType: SkillStep['actionType'],
  targetDescription: string | null,
  matchText: string | null,
  expectedAfter: string,
  extra: Partial<SkillStep> = {},
): SkillStep {
  return {
    id: `mock-step-${sequence}`,
    skillId: CANCEL_ID,
    sequence,
    intent,
    actionType,
    targetDescription,
    inputSource: null,
    expectedBefore: null,
    expectedAfter,
    locatorHint: matchText ? `role=link[name="${matchText}"]` : null,
    requiresApproval: false,
    config: matchText ? { matchText } : {},
    ...extra,
  };
}

const CANCEL_STEPS: SkillStep[] = [
  step(1, 'Open my Lumen+ account', 'navigate', null, null, 'Welcome back', { inputSource: 'url:/account' }),
  step(2, 'Open billing settings', 'click', 'Billing link in the account sidebar', 'Billing', 'Manage membership'),
  step(3, 'Open membership management', 'click', 'Manage membership button', 'Manage membership', 'Cancel membership'),
  step(4, 'Start cancellation', 'click', 'Cancel membership link', 'Cancel membership', 'Before you go'),
  step(5, 'Decline the retention offer', 'click', 'No thanks, continue to cancel button', 'No thanks, continue to cancel', 'Confirm cancellation'),
  step(6, 'Confirm the cancellation', 'click', 'Confirm cancellation button', 'Confirm cancellation', 'Membership canceled', {
    requiresApproval: true,
    locatorHint: 'role=button[name="Confirm cancellation"]',
    config: {
      matchText: 'Confirm cancellation',
      approval: {
        title: 'Cancel $19/month membership?',
        description: 'Agent reached the final cancellation screen. This is irreversible.',
      },
    },
  }),
];

const DONE_MESSAGES = [
  'Opened your Lumen+ account',
  'Opened billing settings',
  'Opened membership management',
  'Started the cancellation',
  'Declined the retention offer (50% off for 3 months)',
  'Confirmed the cancellation',
];

const DAY = 86_400_000;
const created = Date.now() - 40 * DAY;

function baseSkill(over: Partial<SkillDetail> & Pick<SkillDetail, 'id' | 'title' | 'icon'>): SkillDetail {
  return {
    userId: DEMO_USER_ID,
    description: '',
    status: 'active',
    version: 1,
    targetDomains: [],
    startUrl: null,
    verification: {},
    valuePerYear: null,
    runCount: 0,
    successCount: 0,
    confidence: 1,
    lastSuccessAt: null,
    createdAt: iso(created),
    updatedAt: iso(created),
    steps: [],
    triggers: [],
    preferences: {},
    ...over,
  };
}

function skillsSeed(): SkillDetail[] {
  const rec = readRecord();
  const succeeded = rec ? deriveRun(rec, Date.now()).state === 'succeeded' : false;
  const failed = rec ? deriveRun(rec, Date.now()).state === 'failed' : false;
  return [
    baseSkill({
      id: CANCEL_ID,
      title: 'Cancel subscription',
      icon: 'subscription',
      description:
        'Cancels a recurring membership the way you like it: straight to the cancel flow, politely declining retention offers, and always asking you before the final click.',
      targetDomains: ['lumen-plus.demo'],
      startUrl: `${MOCK_SITE}/account`,
      verification: {
        anyOf: [
          { type: 'text_contains', value: 'Membership canceled' },
          { type: 'text_contains', value: 'Renews: No' },
        ],
        allOf: [{ type: 'url_matches', value: '/account/membership' }],
      },
      valuePerYear: 228,
      runCount: 3 + (succeeded || failed ? 1 : 0),
      successCount: 3 + (succeeded ? 1 : 0),
      confidence: 1,
      lastSuccessAt: succeeded && rec ? iso(rec.approvedAt ?? Date.now()) : iso(Date.now() - 12 * DAY),
      steps: CANCEL_STEPS,
      triggers: [
        'cancel subscription',
        'get rid of this subscription',
        'stop paying for this',
        'cancel my membership',
        'unsubscribe from this service',
      ],
      preferences: { confirm_before_cancel: true, decline_retention_offers: true },
    }),
    baseSkill({
      id: 'mock-skill-return',
      title: 'Return online order',
      icon: 'return',
      description: 'Starts a return, picks your refund destination and drop-off spot, and saves the label.',
      runCount: 7,
      successCount: 6,
      confidence: 0.86,
      version: 2,
      lastSuccessAt: iso(Date.now() - 5 * DAY),
      triggers: ['return this order', 'send these back'],
      preferences: { refund_to: 'original payment', drop_off: 'UPS Store', label: 'QR code' },
    }),
    baseSkill({
      id: 'mock-skill-haircut',
      title: 'Book haircut',
      icon: 'haircut',
      description: 'Books your usual cut with your usual barber, Saturday mornings when possible.',
      runCount: 9,
      successCount: 9,
      confidence: 0.97,
      version: 3,
      lastSuccessAt: iso(Date.now() - 20 * DAY),
      triggers: ['book a haircut', 'I need a trim'],
      preferences: { preferred_day: 'Saturday', time: 'morning' },
    }),
    baseSkill({
      id: 'mock-skill-registration',
      title: 'Renew registration',
      icon: 'registration',
      description: 'Renews your vehicle registration online and files the receipt.',
      runCount: 1,
      successCount: 1,
      confidence: 0.8,
      lastSuccessAt: iso(Date.now() - 200 * DAY),
      triggers: ['renew my registration'],
    }),
  ];
}

const summary = (s: SkillDetail): SkillSummary => {
  const { steps: _s, triggers: _t, preferences: _p, ...rest } = s;
  return { ...rest, successRate: s.runCount ? s.successCount / s.runCount : 0 };
};

// ───────────────────────── Run record + derived timeline ─────────────────────────

interface MockRunRecord {
  id: string;
  skillId: string;
  triggerId: string | null;
  startedAt: number;
  approvedAt: number | null;
  stoppedAt: number | null;
  fail: boolean;
}

function readRecord(): MockRunRecord | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as MockRunRecord) : null;
  } catch {
    return null;
  }
}
function writeRecord(rec: MockRunRecord | null) {
  try {
    if (rec) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(rec));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable: mock still works in-memory for this page */
  }
  memoryRecord = rec;
}
let memoryRecord: MockRunRecord | null = null;
const getRecord = () => readRecord() ?? memoryRecord;

interface TimelineEntry {
  at: number; // ms since start
  type: EventType;
  message: string;
  metadata?: Record<string, unknown>;
  state?: RunState;
  currentStep?: number;
  live?: boolean;
}

const APPROVAL_AT = FIRST_STEP_AT + 5 * STEP_MS;

function timeline(rec: MockRunRecord): TimelineEntry[] {
  const t: TimelineEntry[] = [
    { at: 0, type: 'run.started', message: 'Started “Cancel subscription”', state: 'running' },
    { at: 600, type: 'browser.opened', message: 'Opened a secure cloud browser', live: true },
  ];
  for (let i = 1; i <= 5; i++) {
    const s = FIRST_STEP_AT + (i - 1) * STEP_MS;
    const st = CANCEL_STEPS[i - 1];
    t.push({ at: s, type: 'step.started', message: `${st.intent}…`, metadata: { stepSequence: i }, currentStep: i });
    if (rec.fail && i === 4) {
      t.push({
        at: s + 1500,
        type: 'step.failed',
        message: 'Couldn’t find “Cancel membership” on the page',
        metadata: { stepSequence: i },
      });
      t.push({ at: s + 1600, type: 'run.failed', message: 'Run failed', state: 'failed' });
      return t;
    }
    t.push({ at: s + STEP_MS - 200, type: 'step.succeeded', message: DONE_MESSAGES[i - 1], metadata: { stepSequence: i } });
  }
  t.push({
    at: APPROVAL_AT,
    type: 'approval.requested',
    message: 'Waiting for your OK before the final click',
    metadata: { stepSequence: 6 },
    state: 'waiting_approval',
    currentStep: 6,
  });
  if (rec.stoppedAt) {
    const s = rec.stoppedAt - rec.startedAt;
    const kept = t.filter((e) => e.at < s);
    if (s >= APPROVAL_AT) kept.push({ at: s, type: 'approval.denied', message: 'You said stop' });
    kept.push({ at: s, type: 'run.stopped', message: 'Stopped. Nothing was canceled.', state: 'stopped', live: false });
    return kept;
  }
  if (rec.approvedAt) {
    const p = Math.max(rec.approvedAt - rec.startedAt, APPROVAL_AT);
    t.push({ at: p, type: 'approval.granted', message: 'You approved the cancellation', state: 'resumed' });
    t.push({ at: p + 300, type: 'step.started', message: 'Confirm the cancellation…', metadata: { stepSequence: 6 } });
    t.push({ at: p + 1500, type: 'step.succeeded', message: DONE_MESSAGES[5], metadata: { stepSequence: 6 } });
    t.push({ at: p + 1600, type: 'verify.started', message: 'Checking the cancellation really went through', state: 'verifying' });
    t.push({ at: p + 2600, type: 'artifact.saved', message: 'Saved a screenshot as proof', metadata: { artifactId: null } });
    t.push({ at: p + 3200, type: 'verify.passed', message: 'Verified: “Membership canceled”, “Renews: No”' });
    t.push({ at: p + 3200, type: 'run.succeeded', message: 'Lumen+ Premium canceled', state: 'succeeded', live: false });
  }
  return t;
}

function mockLiveUrl(stepNo: number, state: RunState) {
  const page = state === 'succeeded' || state === 'verifying' ? 7 : stepNo;
  return `/mock-live?step=${page}`;
}

function deriveRun(rec: MockRunRecord, now: number) {
  const elapsed = now - rec.startedAt;
  const entries = timeline(rec).filter((e) => e.at <= elapsed);
  let state = 'queued' as RunState;
  let currentStep = 0;
  let live = false;
  const events: ExecutionEvent[] = entries.map((e, idx) => {
    if (e.state) state = e.state;
    if (e.currentStep !== undefined) currentStep = e.currentStep;
    if (e.live !== undefined) live = e.live;
    return {
      id: `${rec.id}-ev-${idx + 1}`,
      runId: rec.id,
      sequence: idx + 1,
      type: e.type,
      message: e.message,
      metadata: e.metadata ?? {},
      createdAt: iso(rec.startedAt + e.at),
    };
  });
  const last = entries[entries.length - 1];
  const doneAt = state === 'succeeded' || state === 'failed' || state === 'stopped' ? rec.startedAt + (last?.at ?? 0) : null;
  const result: RunResult | null =
    state === 'succeeded'
      ? {
          success: true,
          summary: `Lumen+ Premium canceled. You keep access until ${tomorrow()}, then it won’t renew.`,
          evidenceText: ['Membership canceled', 'Renews: No', `Access ends on ${tomorrow()}`],
          finalUrl: `${MOCK_SITE}/account/membership?canceled=1`,
          screenshotArtifactId: null,
          verifiedAt: iso(doneAt ?? now),
          valuePerYear: 228,
        }
      : null;
  const run: SkillRun = {
    id: rec.id,
    skillId: rec.skillId,
    userId: DEMO_USER_ID,
    triggerId: rec.triggerId,
    state,
    currentStep,
    browserSessionId: live ? 'mock-browser' : null,
    liveViewUrl: live ? mockLiveUrl(events.filter((e) => e.type === 'step.succeeded').length, state) : null,
    startedAt: iso(rec.startedAt),
    completedAt: doneAt ? iso(doneAt) : null,
    error: state === 'failed' ? 'Couldn’t find “Cancel membership” on the billing page. The site may have changed.' : null,
    result,
  };
  let approval: Approval | null = null;
  if (events.some((e) => e.type === 'approval.requested')) {
    approval = {
      id: `${rec.id}-approval`,
      runId: rec.id,
      stepSequence: 6,
      status: rec.approvedAt ? 'approved' : rec.stoppedAt ? 'denied' : 'pending',
      title: 'Cancel $19/month membership?',
      description: 'Agent reached the final cancellation screen. This is irreversible.',
      payload: {
        price: '$19/month',
        renewal: `Renews ${tomorrow()}`,
        merchant: 'Lumen+',
        pageUrl: `${MOCK_SITE}/account/membership/cancel/confirm`,
      },
      createdAt: iso(rec.startedAt + APPROVAL_AT),
      decidedAt: rec.approvedAt ? iso(rec.approvedAt) : rec.stoppedAt ? iso(rec.stoppedAt) : null,
    };
  }
  return { run, events, approval, state };
}

const delay = <T,>(v: T, ms = 220) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const notFound = () => Promise.reject(new Error('Not found'));

function history(skill: SkillDetail): SkillRun[] {
  const out: SkillRun[] = [];
  const rec = getRecord();
  if (rec && rec.skillId === skill.id) out.push(deriveRun(rec, Date.now()).run);
  for (let i = 0; i < skill.runCount - (rec && rec.skillId === skill.id ? 1 : 0); i++) {
    const started = Date.now() - (12 + i * 31) * DAY;
    const ok = i < skill.successCount;
    out.push({
      id: `${skill.id}-hist-${i}`,
      skillId: skill.id,
      userId: DEMO_USER_ID,
      triggerId: null,
      state: ok ? 'succeeded' : 'failed',
      currentStep: skill.steps.length,
      browserSessionId: null,
      liveViewUrl: null,
      startedAt: iso(started),
      completedAt: iso(started + 38_000 + i * 4_000),
      error: ok ? null : 'Retailer site was down',
      result: null,
    });
  }
  return out;
}

// ───────────────────────── Mock API (mirrors lib/client/api.ts) ─────────────────────────

export const mockApi = {
  async getToday(): Promise<{ items: TodayItem[] }> {
    const rec = getRecord();
    const state = rec ? deriveRun(rec, Date.now()).state : null;
    const trig =
      state === 'succeeded' ? 'done' : state && state !== 'failed' && state !== 'stopped' ? 'running' : 'pending';
    return delay({
      items: [
        {
          triggerId: TRIGGER_ID,
          title: 'Membership renewal',
          merchant: 'Lumen+',
          amount: '$19/month',
          dueLabel: 'Renews tomorrow',
          matchedSkill: { id: CANCEL_ID, title: 'Cancel subscription' },
          state: trig,
          latestRunId: rec?.id ?? null,
        },
      ],
    });
  },
  async getSkills(): Promise<{ skills: SkillSummary[] }> {
    return delay({ skills: skillsSeed().map(summary) });
  },
  async getSkill(id: string): Promise<{ skill: SkillDetail; runs: SkillRun[] }> {
    const skill = skillsSeed().find((s) => s.id === id);
    if (!skill) return notFound();
    return delay({ skill, runs: history(skill) });
  },
  async listRuns(): Promise<{ runs: SkillRun[] }> {
    const rec = getRecord();
    return delay({ runs: rec ? [deriveRun(rec, Date.now()).run] : [] });
  },
  async startRun(input: { skillId: string; triggerId?: string | null }): Promise<{ runId: string }> {
    const fail = new URLSearchParams(window.location.search).get('mock') === 'fail';
    const rec: MockRunRecord = {
      id: `mock-run-${Date.now().toString(36)}`,
      skillId: input.skillId,
      triggerId: input.triggerId ?? null,
      startedAt: Date.now(),
      approvedAt: null,
      stoppedAt: null,
      fail,
    };
    writeRecord(rec);
    return delay({ runId: rec.id }, 150);
  },
  async getRun(id: string): Promise<RunView> {
    const view = mockApi.getRunSync(id);
    return view ? delay(view, 120) : notFound();
  },
  /** Synchronous snapshot used by the mock stream hook. */
  getRunSync(id: string): RunView | null {
    const rec = getRecord();
    if (!rec || rec.id !== id) return null;
    const skill = skillsSeed().find((s) => s.id === rec.skillId) ?? skillsSeed()[0];
    const d = deriveRun(rec, Date.now());
    return { run: d.run, skill, approval: d.approval, events: d.events };
  },
  async approveRun(id: string): Promise<{ ok: true }> {
    const rec = getRecord();
    if (rec && rec.id === id && !rec.approvedAt && !rec.stoppedAt) writeRecord({ ...rec, approvedAt: Date.now() });
    return delay({ ok: true as const }, 200);
  },
  async stopRun(id: string): Promise<{ ok: true }> {
    const rec = getRecord();
    if (rec && rec.id === id && !rec.stoppedAt) {
      const st = deriveRun(rec, Date.now()).state;
      if (st !== 'succeeded' && st !== 'failed') writeRecord({ ...rec, stoppedAt: Date.now() });
    }
    return delay({ ok: true as const }, 200);
  },
  async resetDemo(): Promise<{ ok: true }> {
    writeRecord(null);
    return delay({ ok: true as const }, 300);
  },
};
