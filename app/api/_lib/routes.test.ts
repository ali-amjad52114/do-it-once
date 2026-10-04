import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_USER_ID, type Approval, type Skill, type SkillRun } from '@/lib/contracts';

const engine = { startRun: vi.fn(), approve: vi.fn(), stop: vi.fn() };

vi.mock('@/lib/engine', () => ({ getRunEngine: () => engine }));
vi.mock('@/lib/neon/repo', () => ({
  getRun: vi.fn(),
  getSkill: vi.fn(),
  listSkills: vi.fn(),
  listRuns: vi.fn(),
  listEvents: vi.fn(),
  getLatestApproval: vi.fn(),
  getArtifact: vi.fn(),
  listTodayItems: vi.fn(),
  resetDemoState: vi.fn(),
}));

import * as repo from '@/lib/neon/repo';
import { POST as startRun, GET as listRunsRoute } from '../runs/route';
import { POST as approve } from '../runs/[id]/approve/route';
import { POST as stop } from '../runs/[id]/stop/route';
import { GET as getRunView } from '../runs/[id]/route';
import { GET as events } from '../runs/[id]/events/route';
import { GET as skills } from '../skills/route';
import { GET as artifact } from '../artifacts/[id]/route';
import { POST as reset } from '../demo/reset/route';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (path: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

function run(patch: Partial<SkillRun> = {}): SkillRun {
  return {
    id: 'r1', skillId: 's1', userId: DEMO_USER_ID, triggerId: null, state: 'running', currentStep: 1,
    browserSessionId: null, liveViewUrl: null, startedAt: 'x', completedAt: null, error: null, result: null, ...patch,
  };
}
const approval = (status: Approval['status']): Approval => ({
  id: 'a1', runId: 'r1', stepSequence: 6, status, title: 't', description: 'd', payload: {}, createdAt: 'x', decidedAt: null,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/runs', () => {
  it('rejects invalid bodies with 400', async () => {
    for (const body of [{}, { skillId: '' }, { skillId: 42 }, { skillId: 's1', triggerId: 7 }, '{not json']) {
      const res = await startRun(post('/api/runs', body));
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe('string');
    }
    expect(engine.startRun).not.toHaveBeenCalled();
  });

  it('404s an unknown skill', async () => {
    vi.mocked(repo.getSkill).mockResolvedValue(null);
    const res = await startRun(post('/api/runs', { skillId: 'nope' }));
    expect(res.status).toBe(404);
  });

  it('starts a run for the demo user', async () => {
    vi.mocked(repo.getSkill).mockResolvedValue({ id: 's1' } as never);
    engine.startRun.mockResolvedValue({ runId: 'r1' });
    const res = await startRun(post('/api/runs', { skillId: 's1', triggerId: 't1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: 'r1' });
    expect(engine.startRun).toHaveBeenCalledWith({ skillId: 's1', userId: DEMO_USER_ID, triggerId: 't1' });
  });

  it('turns engine errors into a JSON 500', async () => {
    vi.mocked(repo.getSkill).mockResolvedValue({ id: 's1' } as never);
    engine.startRun.mockRejectedValue(new Error('boom'));
    const res = await startRun(post('/api/runs', { skillId: 's1' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'boom' });
  });
});

describe('GET /api/runs', () => {
  it('passes a clamped limit', async () => {
    vi.mocked(repo.listRuns).mockResolvedValue([]);
    await listRunsRoute(new Request('http://localhost/api/runs?limit=999'));
    expect(repo.listRuns).toHaveBeenCalledWith(DEMO_USER_ID, { limit: 100 });
  });
});

describe('POST /api/runs/:id/approve', () => {
  it('approves a run waiting for approval', async () => {
    vi.mocked(repo.getRun).mockResolvedValue(run({ state: 'waiting_approval' }));
    vi.mocked(repo.getLatestApproval).mockResolvedValue(approval('pending'));
    const res = await approve(post('/api/runs/r1/approve'), ctx('r1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(engine.approve).toHaveBeenCalledWith('r1');
  });

  it('404s an unknown run and 409s a run with nothing pending', async () => {
    vi.mocked(repo.getRun).mockResolvedValue(null);
    expect((await approve(post('/api/runs/x/approve'), ctx('x'))).status).toBe(404);

    vi.mocked(repo.getRun).mockResolvedValue(run({ state: 'resumed' }));
    vi.mocked(repo.getLatestApproval).mockResolvedValue(approval('approved'));
    expect((await approve(post('/api/runs/r1/approve'), ctx('r1'))).status).toBe(409);
    expect(engine.approve).not.toHaveBeenCalled();
  });
});

describe('POST /api/runs/:id/stop', () => {
  it('stops an active run and refuses a finished one', async () => {
    vi.mocked(repo.getRun).mockResolvedValue(run({ state: 'waiting_approval' }));
    expect((await stop(post('/api/runs/r1/stop'), ctx('r1'))).status).toBe(200);
    expect(engine.stop).toHaveBeenCalledWith('r1');

    vi.mocked(repo.getRun).mockResolvedValue(run({ state: 'succeeded' }));
    expect((await stop(post('/api/runs/r1/stop'), ctx('r1'))).status).toBe(409);
  });
});

describe('GET /api/runs/:id', () => {
  it('returns a RunView', async () => {
    vi.mocked(repo.getRun).mockResolvedValue(run());
    vi.mocked(repo.getSkill).mockResolvedValue({ id: 's1', steps: [] } as never);
    vi.mocked(repo.getLatestApproval).mockResolvedValue(approval('pending'));
    vi.mocked(repo.listEvents).mockResolvedValue([]);
    const body = await (await getRunView(new Request('http://localhost/api/runs/r1'), ctx('r1'))).json();
    expect(Object.keys(body).sort()).toEqual(['approval', 'events', 'run', 'skill']);
    expect(body.approval.id).toBe('a1');
  });
});

describe('GET /api/runs/:id/events', () => {
  it('responds with SSE headers, or 404 for an unknown run', async () => {
    vi.mocked(repo.getRun).mockResolvedValueOnce(null);
    expect((await events(new Request('http://localhost/api/runs/x/events'), ctx('x'))).status).toBe(404);

    vi.mocked(repo.getRun).mockResolvedValue(run({ state: 'stopped' }));
    vi.mocked(repo.listEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', sequence: 1, type: 'run.stopped', message: 'Stopped', metadata: {}, createdAt: 'x' },
    ]);
    vi.mocked(repo.getLatestApproval).mockResolvedValue(null);
    const res = await events(new Request('http://localhost/api/runs/r1/events?after=0'), ctx('r1'));
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const text = await res.text();
    expect(text).toContain('"kind":"done"');
  });
});

describe('GET /api/skills', () => {
  it('adds successRate', async () => {
    const base = { runCount: 4, successCount: 3 } as Skill;
    vi.mocked(repo.listSkills).mockResolvedValue([base, { ...base, runCount: 0, successCount: 0 }]);
    const { skills: list } = await (await skills()).json();
    expect(list.map((s: { successRate: number }) => s.successRate)).toEqual([0.75, 0]);
  });
});

describe('GET /api/artifacts/:id', () => {
  it('serves bytes with the stored content type', async () => {
    vi.mocked(repo.getArtifact).mockResolvedValue({ id: 'x', mimeType: 'image/png', location: 'neon:x', bytes: Buffer.from([1, 2, 3]) } as never);
    const res = await artifact(new Request('http://localhost/api/artifacts/x'), ctx('x'));
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('POST /api/demo/reset', () => {
  it('reports an unreachable demo site but still resets the DB', async () => {
    vi.stubEnv('DEMO_SITE_URL', 'http://127.0.0.1:9');
    vi.stubEnv('DEMO_RESET_TOKEN', 'tok');
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    const body = await (await reset()).json();
    expect(body.ok).toBe(true);
    expect(body.demoSite.ok).toBe(false);
    expect(body.demoSite.error).toContain('ECONNREFUSED');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json', 'x-reset-token': 'tok' });
    expect(repo.resetDemoState).toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});
