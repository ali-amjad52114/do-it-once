'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Wordmark } from '@/components/Brand';
import { LiveView } from '@/components/LiveView';
import { RunPanel } from '@/components/RunPanel';
import { Button, Card, SectionLabel, Spinner } from '@/components/ui';
import type { DiscoveryAttemptView, DiscoveryView, Judgment } from '@/lib/contracts.addons';

type Attempt = DiscoveryAttemptView & { note?: string | null; lastAction?: string | null };
type View = Omit<DiscoveryView, 'attempts'> & { attempts: Attempt[] };

const STATE_LABEL: Record<Attempt['state'], { text: string; cls: string }> = {
  running: { text: 'Exploring', cls: 'bg-tint-sky text-tint-sky-ink' },
  stopped_at_irreversible: { text: 'Stopped before final click', cls: 'bg-approve-soft text-approve-ink' },
  goal_reached: { text: 'Goal reached', cls: 'bg-success-soft text-success-ink' },
  gave_up: { text: 'Gave up', cls: 'bg-tint-slate text-tint-slate-ink' },
  failed: { text: 'Failed', cls: 'bg-danger-soft text-danger-ink' },
  needs_login: { text: 'Needs sign-in', cls: 'bg-approve-soft text-approve-ink' },
};

function JudgeChip({ j }: { j: Judgment | null }) {
  if (!j) return <span className="text-[12px] text-ink-faint">Judge: —</span>;
  const cls =
    j.verdict === 'pass' ? 'bg-success-soft text-success-ink' : j.verdict === 'fail' ? 'bg-danger-soft text-danger-ink' : 'bg-tint-slate text-tint-slate-ink';
  return (
    <span title={j.reasons.join(' · ')} className={`rounded-full px-2.5 py-0.5 text-[12px] font-medium ${cls}`}>
      Judge: {j.verdict}
      {j.verdict !== 'unsure' ? ` ${Math.round(j.confidence * 100)}%` : ''}
    </span>
  );
}

function Lane({ a, winner, finished }: { a: Attempt; winner: boolean; finished: boolean }) {
  const s = STATE_LABEL[a.state] ?? STATE_LABEL.running;
  return (
    <Card className={`p-4 ${winner ? 'ring-2 ring-success' : ''}`}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">Lane {a.lane}</div>
          <div className="text-[15px] font-medium capitalize text-ink">{a.strategy}</div>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-medium ${s.cls}`}>{s.text}</span>
      </div>
      <LiveView url={a.liveViewUrl} ended={a.state !== 'running' || finished} caption={`${a.steps} steps`} />
      <div className="mt-3 flex items-center justify-between gap-2">
        <JudgeChip j={a.judgment} />
        {winner && <span className="text-[12px] font-semibold text-success-ink">Winner</span>}
      </div>
      {(a.lastAction || a.note) && (
        <p className="mt-2 line-clamp-2 text-[12px] text-ink-soft">{a.state === 'running' ? a.lastAction ?? a.note : a.note}</p>
      )}
    </Card>
  );
}

export function DiscoverView({ defaultStartUrl }: { defaultStartUrl: string }) {
  const [goal, setGoal] = useState('');
  const [startUrl, setStartUrl] = useState(defaultStartUrl);
  const [id, setId] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Run the discovered skill right here: live browser → approval card → verified result.
  const runSkill = async (skillId: string) => {
    setStarting(true);
    try {
      const res = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skillId }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not start the run');
      setRunId(body.runId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/discover/${id}/events`);
    es.onmessage = (e) => {
      try {
        const v = JSON.parse(e.data) as View;
        setView(v);
        if (v.state === 'done' || v.state === 'failed') es.close();
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      es.close();
      // Fallback: plain polling.
      const t = setInterval(async () => {
        const r = await fetch(`/api/discover/${id}`, { cache: 'no-store' }).catch(() => null);
        if (!r?.ok) return;
        const v = (await r.json()) as View;
        setView(v);
        if (v.state === 'done' || v.state === 'failed') clearInterval(t);
      }, 2000);
    };
    return () => es.close();
  }, [id]);

  const start = async () => {
    setBusy(true);
    setError(null);
    setView(null);
    try {
      const r = await fetch('/api/discover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal, startUrl }),
      });
      const body = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!r.ok || !body.id) throw new Error(body.error ?? `HTTP ${r.status}`);
      setId(body.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start');
    } finally {
      setBusy(false);
    }
  };

  const [continuing, setContinuing] = useState(false);
  const loginDone = async () => {
    if (!id) return;
    setContinuing(true);
    setError(null);
    try {
      const r = await fetch(`/api/discover/${id}/login-done`, { method: 'POST' });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not continue');
    } finally {
      setContinuing(false);
    }
  };

  const finished = view?.state === 'done' || view?.state === 'failed';
  const running = !!id && !finished;
  const winner = view?.attempts.find((a) => a.id === view.winnerAttemptId) ?? null;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-8 flex items-center justify-between gap-4">
        <Link href="/" aria-label="Home">
          <Wordmark />
        </Link>
        <Link href="/teach" className="text-[14px] text-ink-soft hover:text-ink">
          Teach a chore
        </Link>
      </header>

      <h1 className="mb-2 text-[28px] font-semibold tracking-tight text-ink">Discover a new chore</h1>
      <p className="mb-6 max-w-2xl text-[15px] text-ink-soft">
        Describe something you have never taught. Three agents explore the site in parallel, stop before any final
        irreversible click, and the best path becomes a draft skill you can review.
      </p>

      <Card className="mb-8 p-5">
        <label className="mb-1.5 block text-[13px] font-medium text-ink-soft" htmlFor="goal">
          Goal
        </label>
        <textarea
          id="goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={2}
          placeholder="Start a return for my Lumen Aura headphones, refund to my original card, drop off at UPS Store, QR code label"
          className="mb-4 w-full rounded-xl border border-line-strong bg-paper px-3 py-2 text-[15px] text-ink outline-none focus:border-ink"
        />
        <label className="mb-1.5 block text-[13px] font-medium text-ink-soft" htmlFor="startUrl">
          Start page
        </label>
        <input
          id="startUrl"
          value={startUrl}
          onChange={(e) => setStartUrl(e.target.value)}
          className="mb-4 w-full rounded-xl border border-line-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-ink"
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-approve-ink">Starts 3 cloud browsers (Kernel). Nothing irreversible is ever clicked.</p>
          <Button onClick={start} busy={busy} disabled={running || goal.trim().length < 5 || !startUrl}>
            {running ? 'Discovering…' : 'Discover'}
          </Button>
        </div>
        {error && <p className="mt-3 text-[13px] text-danger-ink">{error}</p>}
      </Card>

      {id && (
        <>
          <SectionLabel
            right={
              <span className="inline-flex items-center gap-2 text-[13px] text-ink-soft">
                {running && <Spinner />}
                {view?.state === 'judging' ? 'Judging final states…' : running ? 'Exploring…' : view?.state === 'done' ? 'Done' : view?.state === 'failed' ? 'No path found' : ''}
              </span>
            }
          >
            Race
          </SectionLabel>
          <div className="mb-8 grid gap-4 md:grid-cols-3">
            {(view?.attempts ?? []).map((a) => (
              <Lane key={a.id} a={a} winner={a.id === view?.winnerAttemptId} finished={finished} />
            ))}
          </div>
        </>
      )}

      {view?.state === 'needs_login' && view.login && (
        <Card className="mb-8 p-5 ring-2 ring-approve">
          <SectionLabel>This site needs you to sign in</SectionLabel>
          <p className="mb-4 max-w-3xl text-[15px] text-ink">
            Type your password yourself — the agent can’t see or store it. It saves the login for next time.
          </p>
          <div className="mb-4 aspect-[16/10] w-full overflow-hidden rounded-xl border border-line-strong bg-paper">
            {view.login.liveViewUrl ? (
              <iframe
                src={view.login.liveViewUrl}
                title="Sign in to the site"
                className="h-full w-full"
                allow="clipboard-read; clipboard-write"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-[14px] text-ink-soft">Opening the browser…</div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={loginDone} busy={continuing} disabled={continuing}>
              I’m signed in — continue
            </Button>
            <span className="text-[13px] text-ink-faint">Saved as {view.login.profile}</span>
          </div>
        </Card>
      )}

      {view?.state === 'done' && winner && (
        <Card className="p-5">
          <SectionLabel>Winner</SectionLabel>
          <p className="mb-4 text-[15px] text-ink">
            Lane {winner.lane} ({winner.strategy}) found the path in {winner.steps} steps
            {winner.judgment ? `, judge ${winner.judgment.verdict}` : ''}. It is saved as a <strong>draft skill</strong>; one
            verified run makes it active.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {view.draftSkillId && !runId && (
              <Button onClick={() => runSkill(view.draftSkillId!)} disabled={starting}>
                {starting ? 'Starting…' : 'Run it now: I’ll approve the final step'}
              </Button>
            )}
            <Link href="/teach" className="text-[14px] text-ink-soft underline-offset-4 hover:text-ink hover:underline">
              Review the steps on Teach
            </Link>
          </div>
        </Card>
      )}
      {runId && (
        <section className="mt-6">
          <RunPanel
            runId={runId}
            onRetry={(skillId) => runSkill(skillId)}
            onSettled={(state) => {
              // A verified run promotes the discovered draft to an active skill (lazy promotion on Teach list).
              if (state === 'succeeded') void fetch('/api/teach/recordings', { cache: 'no-store' });
            }}
          />
        </section>
      )}
      {view?.state === 'failed' && (
        <Card className="p-5 text-[15px] text-ink-soft">No attempt reached the goal. Try a more specific goal or a different start page.</Card>
      )}
    </main>
  );
}
