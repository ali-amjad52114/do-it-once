'use client';
// Render-only UIs for the Mastra agent's backend tools (lib/mastra/agents/chore-agent.ts).
// Keys MUST equal the Mastra tool ids the model sees.
import { useEffect, useState } from 'react';
import { defineToolkit, type ToolCallMessagePartProps } from '@assistant-ui/react';
import type { RunState } from '@/lib/contracts';
import { api, useRunStream } from '@/lib/client/api';
import { Spinner } from '@/components/ui';
import { ExecutorInvokeUI, ExecutorSearchUI } from './executor-ui';
import { handledToolCalls, useRunStarted } from './run-context';

type FindSkillResult = {
  found: boolean;
  skill: { skillId: string; title: string; score: number; matchedPhrase: string | null } | null;
  pendingToday: { subject: string; merchant: string | null; amount: string | null; dueLabel: string | null } | null;
};

type StartRunResult =
  | { started: true; runId: string; skillTitle: string; alreadyRunning: boolean }
  | { started: false; error: string };

type ListSkillsResult = { skills: { skillId: string; title: string; learned: boolean }[] };

const Sparkle = () => (
  <svg viewBox="0 0 24 24" className="size-3.5 shrink-0" aria-hidden>
    <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9L12 3.5Z" fill="currentColor" />
  </svg>
);

function Pending({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-[13px] text-ink-faint">
      <Spinner className="size-3" />
      {children}
    </span>
  );
}

function ErrorChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-danger-soft px-3 py-1 text-[13px] text-danger-ink">
      {children}
    </span>
  );
}

function FindSkillUI({ result, isError, status }: ToolCallMessagePartProps<{ request?: string }, FindSkillResult>) {
  if (!result && (isError || status.type === 'incomplete')) return <ErrorChip>Couldn’t search your skills</ErrorChip>;
  if (!result) return <Pending>Looking through your skills…</Pending>;
  if (!result.found || !result.skill)
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-line-strong px-3 py-1 text-[13px] text-ink-soft">
        No learned skill matches yet
      </span>
    );
  const pct = Math.round(Math.min(1, Math.max(0, result.skill.score)) * 100);
  return (
    <span className="inline-flex animate-fade-up flex-wrap items-center gap-1.5 rounded-full bg-paper-deep px-3 py-1 text-[13px] text-ink-soft">
      <Sparkle />
      Skill found: <span className="font-medium text-ink">{result.skill.title}</span>
      <span aria-hidden className="text-ink-faint">·</span>
      <span className="tabular-nums">{pct}% match</span>
    </span>
  );
}

function StartSkillRunUI({ result, isError, status, toolCallId }: ToolCallMessagePartProps<{ skillId?: string }, StartRunResult>) {
  const ctx = useRunStarted();
  const runId = result && result.started ? result.runId : null;

  useEffect(() => {
    if (!runId || !ctx || handledToolCalls.has(toolCallId)) return;
    handledToolCalls.add(toolCallId);
    ctx.onRunStarted(runId);
  }, [runId, ctx, toolCallId]);

  if (!result && (isError || status.type === 'incomplete')) return <ErrorChip>Couldn’t start the run</ErrorChip>;
  if (!result) return <Pending>Starting your agent…</Pending>;
  if (!result.started) return <ErrorChip>{result.error}</ErrorChip>;
  return <InlineRun runId={result.runId} title={result.skillTitle} where={ctx?.where ?? 'in the run panel'} />;
}

const RUN_LABEL: Record<RunState, string> = {
  queued: 'Getting ready',
  running: 'Working',
  resumed: 'Finishing up',
  waiting_approval: 'Needs your OK',
  verifying: 'Double-checking',
  succeeded: 'Done',
  failed: 'Didn’t finish',
  stopped: 'Stopped',
};

/** Live run status inside the chat: current step, approve/stop when it pauses, and the verified outcome. */
function InlineRun({ runId, title, where }: { runId: string; title: string; where: string }) {
  const { state, currentStep, skill, approval, refresh } = useRunStream(runId);
  const [busy, setBusy] = useState<'approve' | 'stop' | null>(null);
  useEffect(() => {
    if (state !== 'waiting_approval') setBusy(null);
  }, [state]);
  const act = async (kind: 'approve' | 'stop') => {
    setBusy(kind);
    try {
      await (kind === 'approve' ? api.approveRun(runId) : api.stopRun(runId));
      refresh();
    } catch {
      setBusy(null);
    }
  };
  const total = skill?.steps.length ?? 0;
  const step = skill?.steps.find((s) => s.sequence === currentStep);
  const live = !state || ['queued', 'running', 'resumed', 'verifying'].includes(state);
  const tone =
    state === 'succeeded' ? 'bg-success' : state === 'failed' ? 'bg-danger' : state === 'waiting_approval' ? 'bg-approve' : 'bg-live';

  return (
    <div className="w-full max-w-md animate-fade-up rounded-2xl border border-line bg-card p-4 shadow-card">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="relative flex size-2">
          {live && <span className={`absolute inset-0 animate-ping-soft rounded-full ${tone}`} />}
          <span className={`relative size-2 rounded-full ${tone}`} />
        </span>
        <span className="font-medium text-ink">{title}</span>
        <span className="ml-auto text-ink-faint">{state ? RUN_LABEL[state] : 'Starting'}</span>
      </div>
      {total > 0 && (
        <div className="mt-3 flex gap-1" aria-label={`Step ${currentStep} of ${total}`}>
          {skill!.steps.map((s) => (
            <span
              key={s.id}
              className={`h-1 flex-1 rounded-full ${s.sequence < currentStep || state === 'succeeded' ? 'bg-ink' : s.sequence === currentStep ? 'bg-ink/50' : 'bg-line'}`}
            />
          ))}
        </div>
      )}
      {live && step && <p className="mt-2 text-[13px] text-ink-soft">{step.intent}</p>}
      {state === 'waiting_approval' && approval && (
        <div className="mt-3 rounded-xl bg-approve-soft p-3">
          <p className="text-[14px] font-medium text-ink">{approval.title}</p>
          {approval.description && <p className="mt-0.5 text-[13px] text-ink-soft">{approval.description}</p>}
          <div className="mt-2.5 flex gap-2">
            <button disabled={!!busy} onClick={() => act('approve')} className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[13px] text-white hover:bg-ink/90 disabled:opacity-60">
              {busy === 'approve' && <Spinner className="size-3" />}Approve
            </button>
            <button disabled={!!busy} onClick={() => act('stop')} className="rounded-full border border-line-strong bg-card px-4 py-1.5 text-[13px] text-ink-soft hover:bg-paper disabled:opacity-60">
              Stop
            </button>
          </div>
        </div>
      )}
      <p className="mt-2 text-[12px] text-ink-faint">Watch it live {where}.</p>
    </div>
  );
}

function ListSkillsUI({ result, status }: ToolCallMessagePartProps<Record<string, never>, ListSkillsResult>) {
  if (!result && status.type === 'incomplete') return null;
  if (!result) return <Pending>Checking what you’ve taught me…</Pending>;
  const learned = result.skills.filter((s) => s.learned).length;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-paper-deep px-3 py-1 text-[13px] text-ink-soft">
      <Sparkle />
      {learned} learned · {result.skills.length - learned} not learned yet
    </span>
  );
}

export const choreToolkit = defineToolkit({
  findSkill: { type: 'backend', display: 'standalone', render: FindSkillUI },
  startSkillRun: { type: 'backend', display: 'standalone', render: StartSkillRunUI },
  listSkills: { type: 'backend', display: 'standalone', render: ListSkillsUI },
  executorSearch: { type: 'backend', display: 'standalone', render: ExecutorSearchUI },
  executorInvoke: { type: 'backend', display: 'standalone', render: ExecutorInvokeUI },
});
