import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Approval, ExecutionEvent, RunStreamFrame, SkillRun } from '@/lib/contracts';

vi.mock('@/lib/neon/repo', () => ({
  getRun: vi.fn(),
  listEvents: vi.fn(),
  getLatestApproval: vi.fn(),
}));

import * as repo from '@/lib/neon/repo';
import { createRunStream, encodeFrame, pollRunStream } from './sse';

const RUN_ID = 'run-1';

function makeRun(patch: Partial<SkillRun> = {}): SkillRun {
  return {
    id: RUN_ID,
    skillId: 'skill-1',
    userId: 'u',
    triggerId: null,
    state: 'running',
    currentStep: 1,
    browserSessionId: null,
    liveViewUrl: null,
    startedAt: '2026-10-04T00:00:00Z',
    completedAt: null,
    error: null,
    result: null,
    ...patch,
  };
}

function makeEvent(sequence: number, type: ExecutionEvent['type'] = 'step.started'): ExecutionEvent {
  return { id: `e${sequence}`, runId: RUN_ID, sequence, type, message: `event ${sequence}`, metadata: {}, createdAt: '2026-10-04T00:00:00Z' };
}

function makeApproval(status: Approval['status'] = 'pending'): Approval {
  return {
    id: 'a1',
    runId: RUN_ID,
    stepSequence: 6,
    status,
    title: 'Cancel $19/month membership?',
    description: 'Irreversible.',
    payload: {},
    createdAt: '2026-10-04T00:00:00Z',
    decidedAt: null,
  };
}

/**
 * Drives the loop with a scripted DB: each tick reads the next snapshot (the last one repeats).
 * `events` is the full event log at that tick; listEvents filters by `after` like the real repo.
 */
function script(ticks: { run: SkillRun | null; events?: ExecutionEvent[]; approval?: Approval | null }[]) {
  let i = -1;
  const current = () => ticks[Math.min(i, ticks.length - 1)];
  vi.mocked(repo.getRun).mockImplementation(async () => {
    i++;
    return current().run;
  });
  vi.mocked(repo.listEvents).mockImplementation(async (_id, after = 0) => (current().events ?? []).filter((e) => e.sequence > after));
  vi.mocked(repo.getLatestApproval).mockImplementation(async () => current().approval ?? null);
}

async function collect(opts: { after?: number; maxTicks?: number; grace?: number } = {}) {
  const frames: RunStreamFrame[] = [];
  let ticks = 0;
  const max = opts.maxTicks ?? 50;
  await pollRunStream(
    RUN_ID,
    { send: (f) => frames.push(f), isClosed: () => ticks > max },
    { after: opts.after, terminalGraceTicks: opts.grace, sleep: async () => void ticks++ },
  );
  return frames;
}

beforeEach(() => vi.resetAllMocks());

describe('pollRunStream', () => {
  it('sends state, approval and backlog on connect, respecting after', async () => {
    script([
      { run: makeRun({ state: 'waiting_approval', currentStep: 6 }), events: [makeEvent(1), makeEvent(2), makeEvent(3)], approval: makeApproval() },
    ]);
    const frames = await collect({ after: 1, maxTicks: 2 });
    expect(frames.map((f) => f.kind)).toEqual(['state', 'event', 'event', 'approval']);
    expect(frames[0]).toEqual({ kind: 'state', state: 'waiting_approval', currentStep: 6, liveViewUrl: null });
    expect(frames.filter((f) => f.kind === 'event').map((f) => (f as { event: ExecutionEvent }).event.sequence)).toEqual([2, 3]);
  });

  it('emits only new events and state changes, then done on a terminal state', async () => {
    const e = [makeEvent(1, 'run.started'), makeEvent(2), makeEvent(3, 'step.succeeded'), makeEvent(4, 'run.succeeded')];
    script([
      { run: makeRun({ state: 'running', currentStep: 1 }), events: e.slice(0, 1) },
      { run: makeRun({ state: 'running', currentStep: 1 }), events: e.slice(0, 1) }, // no change
      { run: makeRun({ state: 'running', currentStep: 2, liveViewUrl: 'https://live' }), events: e.slice(0, 3) },
      { run: makeRun({ state: 'succeeded', currentStep: 2, liveViewUrl: 'https://live' }), events: e },
    ]);
    const frames = await collect();
    expect(frames.map((f) => f.kind)).toEqual(['state', 'event', 'event', 'event', 'state', 'event', 'state', 'done']);
    expect(frames[4]).toEqual({ kind: 'state', state: 'running', currentStep: 2, liveViewUrl: 'https://live' });
    const done = frames.at(-1) as Extract<RunStreamFrame, { kind: 'done' }>;
    expect(done.run.state).toBe('succeeded');
  });

  it('sends an approval frame when the latest approval status changes', async () => {
    script([
      { run: makeRun({ state: 'waiting_approval', currentStep: 6 }), approval: makeApproval('pending') },
      { run: makeRun({ state: 'waiting_approval', currentStep: 6 }), approval: makeApproval('pending') },
      { run: makeRun({ state: 'resumed', currentStep: 6 }), approval: makeApproval('approved') },
    ]);
    const frames = await collect({ maxTicks: 4 });
    const approvals = frames.filter((f) => f.kind === 'approval') as Extract<RunStreamFrame, { kind: 'approval' }>[];
    expect(approvals.map((a) => a.approval.status)).toEqual(['pending', 'approved']);
  });

  it('waits a grace period for the terminal run event, then sends done anyway', async () => {
    script([
      { run: makeRun({ state: 'failed' }), events: [makeEvent(1, 'run.started')] },
      { run: makeRun({ state: 'failed' }), events: [makeEvent(1, 'run.started'), makeEvent(2, 'run.failed')] },
    ]);
    const frames = await collect({ grace: 3 });
    expect(frames.map((f) => f.kind)).toEqual(['state', 'event', 'event', 'done']);

    vi.mocked(repo.getRun).mockClear();
    script([{ run: makeRun({ state: 'stopped' }) }]);
    const frames2 = await collect({ grace: 2 });
    expect(frames2.map((f) => f.kind)).toEqual(['state', 'done']);
    expect(repo.getRun).toHaveBeenCalledTimes(3); // connect + 2 grace ticks
  });

  it('stops when the client is gone and when the run disappears', async () => {
    script([{ run: makeRun() }]);
    const frames = await collect({ maxTicks: 3 });
    expect(frames.map((f) => f.kind)).toEqual(['state']);
    expect(repo.getRun).toHaveBeenCalledTimes(4);

    script([{ run: null }]);
    expect(await collect()).toEqual([]);
  });

  it('survives a transient DB error', async () => {
    let n = 0;
    vi.mocked(repo.getRun).mockImplementation(async () => {
      if (n++ === 0) throw new Error('db blip');
      return makeRun({ state: 'succeeded' });
    });
    vi.mocked(repo.listEvents).mockResolvedValue([makeEvent(1, 'run.succeeded')]);
    vi.mocked(repo.getLatestApproval).mockResolvedValue(null);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const frames = await collect();
    expect(frames.map((f) => f.kind)).toEqual(['event', 'state', 'done']);
  });
});

describe('createRunStream', () => {
  it('writes SSE-encoded frames and closes after done', async () => {
    script([{ run: makeRun({ state: 'succeeded' }), events: [makeEvent(1, 'run.succeeded')] }]);
    const text = await new Response(createRunStream(RUN_ID, { pollMs: 1 })).text();
    const chunks = text.split('\n\n').filter(Boolean);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.startsWith('data: '))).toBe(true);
    expect(JSON.parse(chunks[2].slice(6)).kind).toBe('done');
    expect(encodeFrame({ kind: 'state', state: 'queued', currentStep: 0, liveViewUrl: null })).toBe(
      'data: {"kind":"state","state":"queued","currentStep":0,"liveViewUrl":null}\n\n',
    );
  });

  it('stops polling when the request is aborted, and sends pings', async () => {
    script([{ run: makeRun() }]);
    const ac = new AbortController();
    const reader = createRunStream(RUN_ID, { pollMs: 5, pingMs: 10, signal: ac.signal }).getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes(': ping')) {
      const { value } = await reader.read();
      text += decoder.decode(value);
    }
    ac.abort();
    const rest = await reader.read();
    expect(rest.done).toBe(true);
    const calls = vi.mocked(repo.getRun).mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(repo.getRun).mock.calls.length).toBe(calls);
  });
});
