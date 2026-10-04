'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { RunState, SkillDetail, SkillRun } from '@/lib/contracts';
import { api, useMockHref } from '@/lib/client/api';
import { Wordmark } from './Brand';
import { pct, runsLabel } from './SkillGrid';
import { SkillIcon } from './SkillIcon';
import { Card, SectionLabel } from './ui';

const PREF_LABELS: Record<string, string> = {
  return_reason: 'Reason',
  refund_destination: 'Refund to',
  dropoff: 'Drop off at',
  label_format: 'Label',
};
const humanKey = (k: string) => {
  if (PREF_LABELS[k]) return PREF_LABELS[k];
  const s = k.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const humanVal = (v: unknown) =>
  v === true ? 'Yes' : v === false ? 'No' : typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v);

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function duration(r: SkillRun) {
  if (!r.completedAt) return null;
  const s = Math.max(0, Math.round((new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const RUN_TONE: Record<RunState, { dot: string; label: string }> = {
  succeeded: { dot: 'bg-success', label: 'Succeeded' },
  failed: { dot: 'bg-danger', label: 'Failed' },
  stopped: { dot: 'bg-line-strong', label: 'Stopped' },
  waiting_approval: { dot: 'bg-approve', label: 'Waiting for approval' },
  queued: { dot: 'bg-live', label: 'Queued' },
  running: { dot: 'bg-live', label: 'Running' },
  resumed: { dot: 'bg-live', label: 'Running' },
  verifying: { dot: 'bg-live', label: 'Verifying' },
};

export function SkillDetailView({ id }: { id: string }) {
  const [data, setData] = useState<{ skill: SkillDetail; runs: SkillRun[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const homeHref = useMockHref('/');

  useEffect(() => {
    api
      .getSkill(id)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load this skill'));
  }, [id]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-24 sm:px-8">
      <header className="flex items-center justify-between py-6 sm:py-8">
        <Wordmark href={homeHref} />
        <Link
          href={homeHref}
          className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[14px] text-ink-soft transition-colors hover:bg-ink/5 hover:text-ink"
        >
          <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
            <path d="M19 12H5M11 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Home
        </Link>
      </header>

      {error ? (
        <Card className="mt-10 p-8 text-center">
          <p className="font-display text-3xl">Skill not found</p>
          <p className="mt-2 text-[15px] text-ink-soft">{error}</p>
        </Card>
      ) : !data ? (
        <div className="mt-10 flex flex-col gap-6">
          <div className="skeleton h-28 rounded-card" />
          <div className="skeleton h-64 rounded-card" />
        </div>
      ) : (
        <Detail skill={data.skill} runs={data.runs} />
      )}
    </div>
  );
}

function Detail({ skill, runs }: { skill: SkillDetail; runs: SkillRun[] }) {
  const rate = skill.runCount ? skill.successCount / skill.runCount : 0;
  const prefs = Object.entries(skill.preferences ?? {});
  const steps = [...skill.steps].sort((a, b) => a.sequence - b.sequence);
  const stats = [
    { k: 'Runs', v: String(skill.runCount) },
    { k: 'Success', v: pct(rate) },
    { k: 'Confidence', v: pct(skill.confidence) },
    { k: 'Version', v: `v${skill.version}` },
  ];

  return (
    <div className="animate-fade-up">
      <section className="pt-6 pb-10 sm:pt-10">
        <SkillIcon icon={skill.icon} size="lg" />
        <h1 className="mt-6 font-display text-[44px] leading-[1.02] text-ink sm:text-[64px]">{skill.title}</h1>
        {skill.description && (
          <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-ink-soft">{skill.description}</p>
        )}
        <dl className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.k} className="rounded-2xl border border-line/70 bg-card px-4 py-3 shadow-card">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">{s.k}</dt>
              <dd className="mt-1 font-display text-[30px] leading-none text-ink">{s.v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-[13px] text-ink-faint">
          {skill.lastSuccessAt ? `Last worked ${fmtDate(skill.lastSuccessAt)}` : 'Not run yet'}
          {skill.valuePerYear ? ` · Worth $${skill.valuePerYear}/year to you` : ''}
        </p>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="p-6">
          <SectionLabel>When to use it</SectionLabel>
          {skill.triggers.length ? (
            <ul className="flex flex-wrap gap-2">
              {skill.triggers.map((t) => (
                <li key={t} className="rounded-full bg-paper-deep px-3.5 py-1.5 text-[14px] text-ink">
                  “{t}”
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[14px] text-ink-faint">No trigger phrases yet.</p>
          )}
        </Card>
        <Card className="p-6">
          <SectionLabel>Your preferences</SectionLabel>
          {prefs.length ? (
            <>
            <ul className="flex flex-wrap gap-2">
              {prefs.map(([k, v]) => (
                <li key={k} className="rounded-full bg-paper-deep px-3.5 py-1.5 text-[14px] text-ink">
                  <span className="text-ink-soft">{humanKey(k)}:</span> <span className="font-medium">{humanVal(v)}</span>
                </li>
              ))}
            </ul>
            {skill.postActions?.length ? (
              <p className="mt-4 text-[13px] text-ink-faint">
                Afterwards:{' '}
                {skill.postActions
                  .map((a) => (a.type === 'save_download' ? `save “${a.linkText}” to the workspace /${a.folder}/` : `add “${a.title}” to your calendar`))
                  .join(' · ')}
              </p>
            ) : null}
            </>
          ) : (
            <p className="text-[14px] text-ink-faint">Your agent uses sensible defaults.</p>
          )}
        </Card>
      </div>

      <Card className="mt-6 p-6 sm:p-7">
        <SectionLabel right={<span className="text-[13px] text-ink-faint">{steps.length} steps</span>}>
          How your agent does it
        </SectionLabel>
        {steps.length ? (
          <ol className="flex flex-col">
            {steps.map((s) => (
              <li key={s.id} className="flex gap-4 border-t border-line py-4 first:border-t-0 first:pt-0 last:pb-0">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-paper-deep font-display text-lg text-ink">
                  {s.sequence}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[16px] font-medium text-ink">{s.intent}</p>
                    {s.requiresApproval && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-approve-soft px-2.5 py-0.5 text-[12px] font-medium text-approve-ink">
                        <svg viewBox="0 0 24 24" className="size-3" aria-hidden>
                          <path d="M12 3.5 20 7v5.5c0 4.4-3.4 7.4-8 8.5-4.6-1.1-8-4.1-8-8.5V7l8-3.5Z" fill="currentColor" />
                        </svg>
                        Approval required
                      </span>
                    )}
                  </div>
                  {s.targetDescription && <p className="mt-1 text-[14px] text-ink-soft">{s.targetDescription}</p>}
                  {s.expectedAfter && (
                    <p className="mt-1 text-[13px] text-ink-faint">
                      Checks for:{' '}
                      {s.expectedAfter.split('|').map((t, i) => (
                        <span key={t}>
                          {i > 0 && ' or '}
                          <span className="text-ink-soft">“{t.trim()}”</span>
                        </span>
                      ))}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-[14px] text-ink-faint">Steps are learned the next time you do this chore.</p>
        )}
      </Card>

      <Card className="mt-6 p-6 sm:p-7">
        <SectionLabel right={<span className="text-[13px] text-ink-faint">{runsLabel(runs.length)}</span>}>
          History
        </SectionLabel>
        {runs.length ? (
          <ul className="flex flex-col">
            {runs.map((r) => {
              const tone = RUN_TONE[r.state];
              const d = duration(r);
              return (
                <li key={r.id} className="flex items-center gap-3 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
                  <span className={`size-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden />
                  <span className="text-[14px] text-ink">{tone.label}</span>
                  <span className="ml-auto text-right text-[13px] text-ink-faint">
                    {fmtDate(r.startedAt)}
                    {d ? ` · ${d}` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[14px] text-ink-faint">No runs yet.</p>
        )}
      </Card>
    </div>
  );
}
