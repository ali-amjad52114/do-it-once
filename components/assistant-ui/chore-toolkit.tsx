'use client';
// Render-only UIs for the Mastra agent's backend tools (lib/mastra/agents/chore-agent.ts).
// Keys MUST equal the Mastra tool ids the model sees.
import { useEffect } from 'react';
import { defineToolkit, type ToolCallMessagePartProps } from '@assistant-ui/react';
import { Spinner } from '@/components/ui';
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
  return (
    <span className="inline-flex animate-fade-up items-center gap-2 rounded-full border border-line bg-card px-3 py-1 text-[13px] text-ink shadow-card">
      <span className="relative flex size-2">
        <span className="absolute inset-0 animate-ping-soft rounded-full bg-live" />
        <span className="relative size-2 rounded-full bg-live" />
      </span>
      {result.alreadyRunning ? 'Already running' : 'Started'} — watch it {ctx?.where ?? 'in the run panel'}
    </span>
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
});
