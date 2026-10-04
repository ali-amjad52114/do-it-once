'use client';
// Typed client for the Do It Once API (docs/CONTRACTS.md "API (B4)").
// Browser-only: never import server modules (lib/neon, lib/engine, lib/kernel, lib/env) here.
// With `?mock=1` in the page URL every call goes to lib/client/mock.ts instead.
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Approval,
  ExecutionEvent,
  RunState,
  RunStreamFrame,
  RunView,
  SkillDetail,
  SkillRun,
  SkillSummary,
  TodayItem,
} from '@/lib/contracts';
import { TERMINAL_STATES } from '@/lib/contracts';
import { mockApi } from './mock';

export function isMockMode(): boolean {
  if (typeof window === 'undefined') return false;
  const v = new URLSearchParams(window.location.search).get('mock');
  return v !== null && v !== '0' && v !== 'false';
}

/** Keeps `?mock=…` on internal links so mock mode survives navigation. */
export function withMock(href: string): string {
  if (!isMockMode()) return href;
  const v = new URLSearchParams(window.location.search).get('mock');
  return `${href}${href.includes('?') ? '&' : '?'}mock=${encodeURIComponent(v ?? '1')}`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    cache: 'no-store',
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

const post = <T,>(path: string, data?: unknown) =>
  http<T>(path, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) });

export const api = {
  getToday(): Promise<{ items: TodayItem[] }> {
    return isMockMode() ? mockApi.getToday() : http('/api/today');
  },
  getSkills(): Promise<{ skills: SkillSummary[] }> {
    return isMockMode() ? mockApi.getSkills() : http('/api/skills');
  },
  getSkill(id: string): Promise<{ skill: SkillDetail; runs: SkillRun[] }> {
    return isMockMode() ? mockApi.getSkill(id) : http(`/api/skills/${encodeURIComponent(id)}`);
  },
  startRun(input: { skillId: string; triggerId?: string | null }): Promise<{ runId: string }> {
    return isMockMode() ? mockApi.startRun(input) : post('/api/runs', input);
  },
  listRuns(limit = 10): Promise<{ runs: SkillRun[] }> {
    return isMockMode() ? mockApi.listRuns() : http(`/api/runs?limit=${limit}`);
  },
  getRun(id: string): Promise<RunView> {
    return isMockMode() ? mockApi.getRun(id) : http(`/api/runs/${encodeURIComponent(id)}`);
  },
  approveRun(id: string): Promise<{ ok: true }> {
    return isMockMode() ? mockApi.approveRun(id) : post(`/api/runs/${encodeURIComponent(id)}/approve`);
  },
  stopRun(id: string): Promise<{ ok: true }> {
    return isMockMode() ? mockApi.stopRun(id) : post(`/api/runs/${encodeURIComponent(id)}/stop`);
  },
  resetDemo(): Promise<{ ok: true }> {
    return isMockMode() ? mockApi.resetDemo() : post('/api/demo/reset');
  },
  artifactUrl(id: string): string {
    return `/api/artifacts/${encodeURIComponent(id)}`;
  },
};

// ───────────────────────── Run stream ─────────────────────────

export interface RunStream {
  state: RunState | null;
  currentStep: number;
  liveViewUrl: string | null;
  events: ExecutionEvent[];
  approval: Approval | null;
  run: SkillRun | null;
  skill: SkillDetail | null;
  /** Last connection/load error, cleared on the next good frame. */
  error: string | null;
  /** Re-reads the run (e.g. right after approve/stop). */
  refresh: () => void;
}

type StreamData = Omit<RunStream, 'refresh'>;

const EMPTY: StreamData = {
  state: null,
  currentStep: 0,
  liveViewUrl: null,
  events: [],
  approval: null,
  run: null,
  skill: null,
  error: null,
};

export function fromView(view: RunView): StreamData {
  return {
    state: view.run.state,
    currentStep: view.run.currentStep,
    liveViewUrl: view.run.liveViewUrl,
    events: [...view.events].sort((a, b) => a.sequence - b.sequence),
    approval: view.approval,
    run: view.run,
    skill: view.skill,
    error: null,
  };
}

function mergeEvents(list: ExecutionEvent[], ev: ExecutionEvent): ExecutionEvent[] {
  if (list.some((e) => e.sequence === ev.sequence)) return list;
  const next = [...list, ev];
  if (list.length && list[list.length - 1].sequence > ev.sequence) next.sort((a, b) => a.sequence - b.sequence);
  return next;
}

/** Pure reducer: folds one SSE frame into the stream state. */
export function foldFrame(s: StreamData, f: RunStreamFrame): StreamData {
  switch (f.kind) {
    case 'event':
      return { ...s, error: null, events: mergeEvents(s.events, f.event) };
    case 'state':
      return {
        ...s,
        error: null,
        state: f.state,
        currentStep: f.currentStep,
        liveViewUrl: f.liveViewUrl,
        run: s.run ? { ...s.run, state: f.state, currentStep: f.currentStep, liveViewUrl: f.liveViewUrl } : s.run,
      };
    case 'approval':
      return { ...s, error: null, approval: f.approval };
    case 'done':
      return {
        ...s,
        error: null,
        run: f.run,
        state: f.run.state,
        currentStep: f.run.currentStep,
        liveViewUrl: f.run.liveViewUrl,
      };
  }
}

const isTerminal = (st: RunState | null) => !!st && TERMINAL_STATES.includes(st);

/**
 * Live view of one run. Loads `GET /api/runs/:id`, then follows the SSE stream
 * `/api/runs/:id/events?after=<last sequence>` and reconnects (with backoff) until the run
 * reaches a terminal state. In mock mode it polls the in-browser simulation instead.
 */
export function useRunStream(runId: string | null): RunStream {
  const [data, setData] = useState<StreamData>(EMPTY);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const lastSeq = useRef(0);

  useEffect(() => {
    lastSeq.current = 0;
    setData(EMPTY);
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    let disposed = false;

    if (isMockMode()) {
      const tick = () => {
        const view = mockApi.getRunSync(runId);
        if (!view) {
          setData((s) => ({ ...s, error: 'Run not found' }));
          return;
        }
        setData(fromView(view));
        if (isTerminal(view.run.state)) window.clearInterval(timer);
      };
      const timer = window.setInterval(tick, 250);
      tick();
      return () => window.clearInterval(timer);
    }

    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let finished = false;

    const scheduleRetry = () => {
      if (disposed || finished) return;
      const wait = Math.min(1000 * 2 ** attempts, 8000);
      attempts++;
      retryTimer = setTimeout(load, wait);
    };

    const connect = () => {
      if (disposed || finished) return;
      es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?after=${lastSeq.current}`);
      es.onopen = () => {
        attempts = 0;
      };
      es.onmessage = (msg) => {
        let frame: RunStreamFrame;
        try {
          frame = JSON.parse(msg.data) as RunStreamFrame;
        } catch {
          return;
        }
        if (frame.kind === 'event') lastSeq.current = Math.max(lastSeq.current, frame.event.sequence);
        if (frame.kind === 'done') {
          finished = true;
          es?.close();
        }
        setData((s) => foldFrame(s, frame));
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (!finished) {
          setData((s) => ({ ...s, error: 'Reconnecting…' }));
          scheduleRetry();
        }
      };
    };

    // (Re)load the full view first so a reconnect never misses state/approval changes.
    async function load() {
      try {
        const view = await api.getRun(runId!);
        if (disposed) return;
        const d = fromView(view);
        lastSeq.current = d.events.reduce((m, e) => Math.max(m, e.sequence), lastSeq.current);
        setData(d);
        if (isTerminal(view.run.state)) {
          finished = true;
          return;
        }
        connect();
      } catch (e) {
        if (disposed) return;
        setData((s) => ({ ...s, error: e instanceof Error ? e.message : 'Could not load the run' }));
        if (!(e instanceof ApiError && e.status === 404)) scheduleRetry();
      }
    }

    void load();
    return () => {
      disposed = true;
      es?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [runId, nonce]);

  return { ...data, refresh };
}

/** `withMock(href)` that is hydration-safe: plain href on the server/first render. */
export function useMockHref(href: string): string {
  const [h, setH] = useState(href);
  useEffect(() => setH(withMock(href)), [href]);
  return h;
}
