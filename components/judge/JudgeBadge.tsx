'use client';
// A3 AI judge badge: polls /api/judge/:runId every 2 s until a judgment exists, then shows a compact verdict.
import { useEffect, useState } from 'react';
import type { JudgmentView } from '@/lib/contracts.addons';

const POLL_MS = 2000;
const MAX_POLLS = 60; // give up after ~2 minutes

export function JudgeBadge({ runId }: { runId: string }) {
  const [view, setView] = useState<JudgmentView | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    let alive = true;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setView(null);
    setGaveUp(false);
    const tick = async () => {
      polls++;
      try {
        const res = await fetch(`/api/judge/${runId}`, { cache: 'no-store' });
        if (res.ok) {
          const v = (await res.json()) as JudgmentView;
          if (!alive) return;
          setView(v);
          if (v.judgment) return; // done
        }
      } catch {
        /* keep polling */
      }
      if (!alive) return;
      if (polls >= MAX_POLLS) setGaveUp(true);
      else timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  const j = view?.judgment ?? null;
  if (!j) {
    if (gaveUp) return null;
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-line bg-paper-deep px-3 py-1 text-xs font-medium text-ink-soft">
        <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-ink-faint" aria-hidden="true" />
        AI judge checking the screenshot…
      </div>
    );
  }

  const pct = `${Math.round(j.confidence * 100)}%`;
  const combined = view?.combined;
  const style =
    j.verdict === 'pass'
      ? { box: 'border-success/30 bg-success-soft text-success-ink', dot: 'bg-success', label: `AI judge: Pass · ${pct}` }
      : j.verdict === 'fail'
        ? {
            box: 'border-approve/30 bg-approve-soft text-approve-ink',
            dot: 'bg-approve',
            label: combined === 'failed' ? `AI judge: Fail · ${pct}` : `Needs review · AI judge: Fail · ${pct}`,
          }
        : { box: 'border-line-strong bg-tint-slate text-tint-slate-ink', dot: 'bg-ink-faint', label: 'Judge unsure' };
  const showReasons = j.verdict !== 'pass' && j.reasons.length > 0;

  return (
    <div className={`animate-fade-up rounded-tile border px-3 py-2 text-xs ${style.box}`} title={`${j.model} · ${(j.latencyMs / 1000).toFixed(1)}s`}>
      <div className="flex items-center gap-2 font-semibold">
        <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden="true" />
        {style.label}
      </div>
      {showReasons && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 font-normal">
          {j.reasons.slice(0, 3).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default JudgeBadge;
