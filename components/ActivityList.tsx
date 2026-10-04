'use client';
import type { ExecutionEvent, RunState, SkillStep } from '@/lib/contracts';
import { HealBlock, healEvents } from './heal/HealBlock';

export type LineStatus = 'done' | 'active' | 'waiting' | 'pending' | 'failed' | 'skipped';

export interface ActivityLine {
  key: string;
  label: string;
  detail?: string;
  status: LineStatus;
  /** Self-heal events shown under the step where the website changed. */
  heal?: ExecutionEvent[];
}

const stepOf = (e: ExecutionEvent) =>
  typeof e.metadata?.stepSequence === 'number' ? (e.metadata.stepSequence as number) : null;

/** Builds the checklist from the skill steps plus the event log. */
export function buildActivity(
  steps: SkillStep[],
  events: ExecutionEvent[],
  state: RunState | null,
  currentStep: number,
): ActivityLine[] {
  const has = (t: ExecutionEvent['type']) => events.some((e) => e.type === t);
  const ok = new Set(events.filter((e) => e.type === 'step.succeeded').map(stepOf));
  const bad = new Set(events.filter((e) => e.type === 'step.failed').map(stepOf));
  const lastFor = (seq: number) =>
    [...events].reverse().find((e) => stepOf(e) === seq && (e.type === 'step.succeeded' || e.type === 'step.failed'));
  const live = state === 'running' || state === 'resumed' || state === 'queued';
  const ended = state === 'failed' || state === 'stopped';
  const pastSteps = state === 'verifying' || state === 'succeeded';

  const lines: ActivityLine[] = [];

  const browserDone = has('browser.opened') || currentStep > 0 || pastSteps || ok.size > 0;
  lines.push({
    key: 'browser',
    label: 'Open a secure browser',
    status: browserDone ? 'done' : ended ? 'skipped' : state ? 'active' : 'pending',
  });

  const sorted = [...steps].sort((a, b) => a.sequence - b.sequence);
  const heal = healEvents(events);
  const healSeq = heal ? stepOf(heal[0]) : null;
  for (const s of sorted) {
    let status: LineStatus = 'pending';
    if (bad.has(s.sequence) || (state === 'failed' && s.sequence === currentStep && !ok.has(s.sequence))) status = 'failed';
    else if (ok.has(s.sequence) || pastSteps || (currentStep > s.sequence && state !== 'failed')) status = 'done';
    else if (s.sequence === currentStep && state === 'waiting_approval') status = 'waiting';
    else if (s.sequence === currentStep && live && browserDone) status = 'active';
    else if (ended) status = 'skipped';
    const ev = lastFor(s.sequence);
    lines.push({
      key: s.id,
      label: s.intent,
      detail: status === 'failed' ? ev?.message : status === 'waiting' ? 'Waiting for your OK' : undefined,
      status,
      ...(heal && healSeq === s.sequence ? { heal } : {}),
    });
  }

  lines.push({
    key: 'verify',
    label: 'Verify it really happened',
    status:
      state === 'succeeded'
        ? 'done'
        : state === 'verifying'
          ? 'active'
          : has('verify.failed')
            ? 'failed'
            : ended
              ? 'skipped'
              : 'pending',
    detail: has('verify.failed') ? events.find((e) => e.type === 'verify.failed')?.message : undefined,
  });
  return lines;
}

function Marker({ status }: { status: LineStatus }) {
  switch (status) {
    case 'done':
      return (
        <span className="flex size-6 items-center justify-center rounded-full bg-ink text-white animate-pop">
          <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden>
            <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      );
    case 'active':
      return (
        <span className="relative flex size-6 items-center justify-center">
          <span className="absolute inset-0 animate-ping-soft rounded-full bg-live/40" />
          <span className="relative size-3 animate-breathe rounded-full bg-live" />
        </span>
      );
    case 'waiting':
      return (
        <span className="relative flex size-6 items-center justify-center">
          <span className="absolute inset-0 animate-ping-soft rounded-full bg-approve/40" />
          <span className="relative size-3 rounded-full bg-approve" />
        </span>
      );
    case 'failed':
      return (
        <span className="flex size-6 items-center justify-center rounded-full bg-danger text-white animate-pop">
          <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden>
            <path d="M7 7l10 10M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </span>
      );
    default:
      return <span className="m-[3px] block size-[18px] rounded-full border-[1.5px] border-dashed border-line-strong" />;
  }
}

const SR: Record<LineStatus, string> = {
  done: 'done',
  active: 'in progress',
  waiting: 'waiting for approval',
  pending: 'pending',
  failed: 'failed',
  skipped: 'not run',
};

export function ActivityList({ lines }: { lines: ActivityLine[] }) {
  return (
    <ol className="relative" aria-live="polite">
      {lines.map((l, i) => (
        <li key={l.key} className="relative flex gap-3.5 pb-4 last:pb-0">
          {i < lines.length - 1 && (
            <span
              className={`absolute left-[11.5px] top-7 bottom-1 w-px transition-colors duration-500 ${
                l.status === 'done' ? 'bg-ink/25' : 'bg-line'
              }`}
              aria-hidden
            />
          )}
          <span className="relative z-10 shrink-0 bg-card">
            <Marker status={l.status} />
          </span>
          <div className="min-w-0 pt-0.5">
            <p
              className={`text-[15px] leading-snug transition-colors duration-300 ${
                l.status === 'pending' || l.status === 'skipped'
                  ? 'text-ink-faint'
                  : l.status === 'failed'
                    ? 'font-medium text-danger-ink'
                    : l.status === 'active' || l.status === 'waiting'
                      ? 'font-medium text-ink'
                      : 'text-ink'
              }`}
            >
              {l.label}
              <span className="sr-only"> — {SR[l.status]}</span>
            </p>
            {l.heal && <HealBlock events={l.heal} />}
            {l.detail && (
              <p className={`mt-0.5 text-[13px] ${l.status === 'failed' ? 'text-danger-ink/80' : 'text-approve-ink'}`}>
                {l.detail}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
