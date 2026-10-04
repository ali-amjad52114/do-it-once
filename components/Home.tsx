'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SkillSummary, TodayItem } from '@/lib/contracts';
import { api, isMockMode } from '@/lib/client/api';
import { Wordmark } from './Brand';
import { RunPanel } from './RunPanel';
import { SkillGrid } from './SkillGrid';
import { TodayCard } from './TodayCard';
import { SectionLabel, Spinner } from './ui';

function greeting(d: Date) {
  const h = d.getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function Home() {
  const [items, setItems] = useState<TodayItem[] | null>(null);
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [hello, setHello] = useState<{ greet: string; date: string } | null>(null);
  const [mock, setMock] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const attached = useRef(false);

  const loadToday = useCallback(async () => {
    const { items } = await api.getToday();
    setItems(items);
    // On first load, re-attach to the latest run so a refresh restores everything.
    if (!attached.current) {
      attached.current = true;
      const latest = items.find((i) => i.latestRunId)?.latestRunId ?? null;
      if (latest) setRunId((cur) => cur ?? latest);
    }
  }, []);

  const loadSkills = useCallback(async () => {
    const { skills } = await api.getSkills();
    setSkills(skills);
  }, []);

  useEffect(() => {
    const now = new Date();
    setHello({
      greet: greeting(now),
      date: now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
    });
    setMock(isMockMode());
    loadToday().catch((e) => {
      setItems([]);
      setError(`Couldn’t reach your agent right now. ${e instanceof Error ? e.message : ''}`.trim());
    });
    loadSkills().catch(() => setSkills([]));
  }, [loadToday, loadSkills]);

  const start = useCallback(
    async (skillId: string, triggerId: string | null) => {
      setStarting(triggerId ?? skillId);
      setError(null);
      try {
        const { runId } = await api.startRun({ skillId, triggerId });
        setRunId(runId);
        requestAnimationFrame(() =>
          panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        );
        loadToday().catch(() => {});
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not start the run');
      } finally {
        setStarting(null);
      }
    },
    [loadToday],
  );

  const onSettled = useCallback(() => {
    loadToday().catch(() => {});
    loadSkills().catch(() => {});
  }, [loadToday, loadSkills]);

  const reset = async () => {
    setResetting(true);
    try {
      await api.resetDemo();
    } catch {
      /* reload anyway */
    }
    window.location.reload();
  };

  const activeTrigger = runId && items ? items.find((i) => i.latestRunId === runId)?.triggerId : null;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 sm:px-8">
      <header className="flex items-center justify-between py-6 sm:py-8">
        <Wordmark />
        <div className="flex items-center gap-2">
          {mock && (
            <span className="hidden rounded-full bg-paper-deep px-2.5 py-1 text-[11px] sm:inline font-medium uppercase tracking-[0.14em] text-ink-faint">
              Demo data
            </span>
          )}
          <button
            onClick={reset}
            disabled={resetting}
            className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] text-ink-faint transition-colors hover:bg-ink/5 hover:text-ink-soft disabled:opacity-60"
          >
            {resetting ? (
              <Spinner className="size-3.5" />
            ) : (
              <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden>
                <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4.5v3.8h3.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            Reset demo
          </button>
        </div>
      </header>

      <section className="pt-8 pb-14 sm:pt-16 sm:pb-20">
        <p className="h-5 text-[14px] text-ink-faint">{hello ? `${hello.greet}, Ali · ${hello.date}` : ''}</p>
        <h1 className="mt-4 max-w-4xl font-display text-[46px] leading-[1.02] tracking-[-0.01em] text-ink sm:text-[80px] lg:text-[92px]">
          Your agent remembers how you <em className="text-ink-soft">handle life.</em>
        </h1>
        <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-ink-soft sm:text-lg">
          Do it once. Your agent does it forever, and checks with you before anything you can’t undo.
        </p>
      </section>

      <section aria-labelledby="today" className="mb-14">
        <SectionLabel>
          <span id="today">Today</span>
        </SectionLabel>
        {error && (
          <p role="alert" className="mb-4 rounded-2xl bg-danger-soft px-4 py-3 text-[14px] text-danger-ink">
            {error}
          </p>
        )}
        {items === null ? (
          <div className="skeleton h-[132px] rounded-card" />
        ) : items.length === 0 && !error ? (
          <p className="rounded-card border border-dashed border-line-strong px-6 py-10 text-center text-[15px] text-ink-soft">
            Nothing needs you today. Enjoy it.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {items.map((item) => (
              <TodayCard
                key={item.triggerId}
                item={item}
                active={!!runId && activeTrigger === item.triggerId && item.state === 'running'}
                busy={starting === item.triggerId}
                onRun={() => item.matchedSkill && start(item.matchedSkill.id, item.triggerId)}
              />
            ))}
          </div>
        )}
      </section>

      {runId && (
        <section ref={panelRef} aria-label="Active run" className="mb-16 scroll-mt-6">
          <RunPanel key={runId} runId={runId} onRetry={start} onSettled={onSettled} />
        </section>
      )}

      <section aria-labelledby="skills">
        <SectionLabel right={<span className="text-[13px] text-ink-faint">Learned from you</span>}>
          <span id="skills">My skills</span>
        </SectionLabel>
        <SkillGrid skills={skills} />
      </section>

      <footer className="mt-24 flex flex-col items-center gap-3 text-center text-[13px] text-ink-faint">
        <span className="font-display text-xl italic text-ink-soft">Do it once. Your agent does it forever.</span>
      </footer>
    </div>
  );
}
