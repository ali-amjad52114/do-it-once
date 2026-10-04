'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunState } from '@/lib/contracts';
import { ProofPanel } from '@/components/evidence/ProofPanel';
import { api, useRunStream } from '@/lib/client/api';
import { ActivityList, buildActivity } from './ActivityList';
import { ApprovalCard } from './ApprovalCard';
import { LiveView } from './LiveView';
import { SuccessHero } from './SuccessHero';
import { Button, Card, SectionLabel } from './ui';

const PILL: Record<RunState, { label: string; tone: string }> = {
  queued: { label: 'Getting ready', tone: 'bg-paper-deep text-ink-soft' },
  running: { label: 'Working', tone: 'bg-paper-deep text-ink' },
  resumed: { label: 'Finishing up', tone: 'bg-paper-deep text-ink' },
  waiting_approval: { label: 'Needs your OK', tone: 'bg-approve-soft text-approve-ink' },
  verifying: { label: 'Double-checking', tone: 'bg-paper-deep text-ink' },
  succeeded: { label: 'Done', tone: 'bg-success-soft text-success-ink' },
  failed: { label: 'Didn’t finish', tone: 'bg-danger-soft text-danger-ink' },
  stopped: { label: 'Stopped', tone: 'bg-paper-deep text-ink-soft' },
};

function successWord(icon: string | undefined, title: string | undefined) {
  if (icon === 'subscription' || /cancel/i.test(title ?? '')) return 'Canceled';
  if (icon === 'return') return 'Returned';
  if (icon === 'haircut') return 'Booked';
  if (icon === 'registration') return 'Renewed';
  return 'Done';
}

export function RunPanel({
  runId,
  onRetry,
  onSettled,
}: {
  runId: string;
  onRetry: (skillId: string, triggerId: string | null) => void;
  /** Called once when the run reaches a terminal state (to refresh Today / Skills). */
  onSettled?: (state: RunState) => void;
}) {
  const stream = useRunStream(runId);
  const { state, run, skill, events, approval, currentStep, liveViewUrl, error } = stream;
  const [busy, setBusy] = useState<'approve' | 'stop' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const lines = useMemo(
    () => buildActivity(skill?.steps ?? [], events, state, currentStep),
    [skill, events, state, currentStep],
  );

  // Clear the button spinner once the run moves past the approval.
  useEffect(() => {
    if (state !== 'waiting_approval') setBusy(null);
  }, [state]);

  const settledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!state || !onSettled) return;
    if ((state === 'succeeded' || state === 'failed' || state === 'stopped') && settledFor.current !== runId) {
      settledFor.current = runId;
      onSettled(state);
    }
  }, [state, runId, onSettled]);

  const act = async (kind: 'approve' | 'stop') => {
    setBusy(kind);
    setActionError(null);
    try {
      await (kind === 'approve' ? api.approveRun(runId) : api.stopRun(runId));
      stream.refresh();
    } catch (e) {
      setBusy(null);
      setActionError(e instanceof Error ? e.message : 'Something went wrong');
    }
  };

  if (!state || !run) {
    return (
      <Card className="p-6 sm:p-8">
        <SectionLabel>Agent activity</SectionLabel>
        {error && error !== 'Reconnecting…' ? (
          <p className="text-[15px] text-ink-soft">Couldn’t load this run. {error}</p>
        ) : (
          <div className="grid gap-6 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <div className="flex flex-col gap-4">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="skeleton h-4 rounded-full" style={{ width: `${80 - i * 12}%` }} />
              ))}
            </div>
            <div className="skeleton aspect-[16/10] rounded-2xl" />
          </div>
        )}
      </Card>
    );
  }

  const pill = PILL[state];

  if (state === 'succeeded' && run.result) {
    return (
      <div className="flex flex-col gap-6">
        <SuccessHero result={run.result} word={successWord(skill?.icon, skill?.title)} />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <Card className="p-6 sm:p-7">
            <SectionLabel>What your agent did</SectionLabel>
            <ActivityList lines={lines} />
          </Card>
          <div className="min-w-0 overflow-x-auto">
            <ProofPanel result={run.result} />
          </div>
        </div>
      </div>
    );
  }

  const waiting = state === 'waiting_approval' && approval && approval.status === 'pending';
  const ended = state === 'failed' || state === 'stopped' || state === 'succeeded';

  return (
    <div className="flex flex-col gap-5">
      {waiting && (
        <ApprovalCard approval={approval} busy={busy} onApprove={() => act('approve')} onStop={() => act('stop')} />
      )}
      {actionError && (
        <p role="alert" className="rounded-2xl bg-danger-soft px-4 py-3 text-[14px] text-danger-ink">
          {actionError}
        </p>
      )}

      {state === 'failed' && (
        <section className="animate-fade-up overflow-hidden rounded-card border border-danger/25 bg-danger-soft">
          <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:p-6">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-danger text-white">
              <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
                <path d="M12 7v6M12 16.5h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-display text-[28px] leading-tight text-ink">Your agent couldn’t finish</p>
              <p className="mt-1 text-[15px] text-danger-ink">{run.error ?? 'Something unexpected happened.'}</p>
              {!events.some((e) => e.type === 'approval.granted') && (
                <p className="mt-1 text-[13px] text-ink-soft">Nothing irreversible was done.</p>
              )}
            </div>
            <Button onClick={() => onRetry(run.skillId, run.triggerId)}>Try again</Button>
          </div>
        </section>
      )}

      {state === 'stopped' && (
        <section className="animate-fade-up flex flex-col gap-4 rounded-card border border-line bg-card p-5 shadow-card sm:flex-row sm:items-center sm:p-6">
          <div className="flex-1">
            <p className="font-display text-[28px] leading-tight text-ink">Stopped. Nothing was changed.</p>
            <p className="mt-1 text-[15px] text-ink-soft">Your agent closed the browser before the final step.</p>
          </div>
          <Button variant="secondary" onClick={() => onRetry(run.skillId, run.triggerId)}>
            Run again
          </Button>
        </section>
      )}

      <Card className="p-5 sm:p-7">
        <SectionLabel
          right={
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium ${pill.tone}`}>
              {pill.label}
            </span>
          }
        >
          Agent activity
        </SectionLabel>
        {skill && (
          <p className="-mt-1 mb-5 font-display text-[26px] leading-tight text-ink sm:text-[30px]">{skill.title}</p>
        )}
        <div className="grid gap-7 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-8">
          <ActivityList lines={lines} />
          <LiveView
            url={liveViewUrl}
            ended={ended}
            caption={error === 'Reconnecting…' ? 'Reconnecting…' : undefined}
          />
        </div>
      </Card>
    </div>
  );
}
