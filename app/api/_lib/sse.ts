// SSE run stream for GET /api/runs/:id/events. Server-only.
// Polls Neon (via lib/neon/repo) and turns changes into RunStreamFrame messages.
import { getLatestApproval, getRun, listEvents } from '@/lib/neon/repo';
import type { Approval, RunStreamFrame, SkillRun } from '@/lib/contracts';
import { isTerminal } from './http';

export const SSE_HEADERS: HeadersInit = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export function encodeFrame(frame: RunStreamFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

export function encodeComment(text: string): string {
  return `: ${text}\n\n`;
}

export interface RunStreamSink {
  send(frame: RunStreamFrame): void;
  /** True once the client went away or the stream was cancelled/closed. */
  isClosed(): boolean;
}

export interface PollOptions {
  /** Only events with sequence > after are sent. */
  after?: number;
  pollMs?: number;
  /**
   * After the run reaches a terminal state, keep polling up to this many ticks for the
   * terminal run.* event (the engine may write it just after the state) before sending done.
   */
  terminalGraceTicks?: number;
  /** Abortable sleep; resolves early when the stream closes. */
  sleep?: (ms: number) => Promise<void>;
}

const TERMINAL_EVENTS = new Set(['run.succeeded', 'run.failed', 'run.stopped']);

const stateKey = (r: SkillRun) => `${r.state}|${r.currentStep}|${r.liveViewUrl ?? ''}`;
const approvalKey = (a: Approval | null) => (a ? `${a.id}|${a.status}` : '');

/**
 * The polling loop. On connect: state, approval (if any), events after `after`.
 * Then every pollMs: new events, state/approval changes. On a terminal state: done, return.
 * Returns when the run finishes, disappears, or the sink is closed.
 */
export async function pollRunStream(runId: string, sink: RunStreamSink, opts: PollOptions = {}): Promise<void> {
  const pollMs = opts.pollMs ?? 500;
  const grace = opts.terminalGraceTicks ?? 4;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastSeq = Math.max(0, opts.after ?? 0);
  let lastState: string | null = null;
  let lastApproval = '';
  let sawTerminalEvent = false;
  let terminalTicks = 0;
  let first = true;

  while (!sink.isClosed()) {
    if (!first) await sleep(pollMs);
    if (sink.isClosed()) return;

    let run: SkillRun | null;
    try {
      run = await getRun(runId);
      if (!run) return; // deleted (e.g. demo reset): end the stream
      const [events, approval] = await Promise.all([listEvents(runId, lastSeq), getLatestApproval(runId)]);
      if (sink.isClosed()) return;

      const sendState = () => {
        const key = stateKey(run!);
        if (key !== lastState) {
          lastState = key;
          sink.send({ kind: 'state', state: run!.state, currentStep: run!.currentStep, liveViewUrl: run!.liveViewUrl });
        }
      };
      // On connect: state first (snapshot). Afterwards: events first, so the UI never shows
      // a new state before the step event that caused it.
      if (first) sendState();
      for (const event of events) {
        if (event.sequence <= lastSeq) continue;
        lastSeq = event.sequence;
        if (TERMINAL_EVENTS.has(event.type)) sawTerminalEvent = true;
        sink.send({ kind: 'event', event });
      }
      const aKey = approvalKey(approval);
      if (approval && aKey !== lastApproval) {
        lastApproval = aKey;
        sink.send({ kind: 'approval', approval });
      }
      sendState();
    } catch (err) {
      // Transient DB error: keep the stream open and try again next tick.
      console.error(`[sse] poll failed for run ${runId}:`, err);
      first = false;
      continue;
    }
    first = false;

    if (isTerminal(run.state)) {
      if (sawTerminalEvent || terminalTicks >= grace) {
        sink.send({ kind: 'done', run });
        return;
      }
      terminalTicks++;
    }
  }
}

export interface RunStreamOptions extends Omit<PollOptions, 'sleep'> {
  signal?: AbortSignal;
  pingMs?: number;
}

/** A ReadableStream of SSE bytes for one run. Closes on done, client abort or cancel. */
export function createRunStream(runId: string, opts: RunStreamOptions = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pingMs = opts.pingMs ?? 15_000;
  let closed = false;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  const sleepers = new Set<() => void>();
  let onAbort: (() => void) | undefined;

  const cleanup = () => {
    closed = true;
    if (pingTimer) clearInterval(pingTimer);
    for (const wake of sleepers) wake();
    sleepers.clear();
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (closed) return resolve();
      const t = setTimeout(() => {
        sleepers.delete(wake);
        resolve();
      }, ms);
      const wake = () => {
        clearTimeout(t);
        resolve();
      };
      sleepers.add(wake);
    });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const close = () => {
        if (closed) return;
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      if (opts.signal) {
        if (opts.signal.aborted) return close();
        onAbort = close;
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      pingTimer = setInterval(() => write(encodeComment('ping')), pingMs);

      const sink: RunStreamSink = { send: (f) => write(encodeFrame(f)), isClosed: () => closed };
      pollRunStream(runId, sink, { after: opts.after, pollMs: opts.pollMs, terminalGraceTicks: opts.terminalGraceTicks, sleep })
        .catch((err) => console.error(`[sse] stream failed for run ${runId}:`, err))
        .finally(close);
    },
    cancel() {
      cleanup();
    },
  });
}
