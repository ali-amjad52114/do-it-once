'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Wordmark } from '@/components/Brand';
import { RunPanel } from '@/components/RunPanel';
import { SkillIcon } from '@/components/SkillIcon';
import { Button, Card, SectionLabel, Spinner } from '@/components/ui';
import type { TaughtSkillDraft } from '@/lib/learn/normalize';

interface RecItem {
  id: string;
  status: 'received' | 'normalized' | 'saved' | 'failed';
  createdAt: string;
  startUrl: string;
  actionCount: number;
  title: string | null;
  skillId: string | null;
  skillStatus: string | null;
  error: string | null;
}

interface RecDetail {
  id: string;
  status: RecItem['status'];
  normalized: TaughtSkillDraft | null;
  skillId: string | null;
  skillStatus: string | null;
  error: string | null;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};
const time = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const humanKey = (k: string) => {
  const s = k.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const STATUS: Record<string, { label: string; cls: string }> = {
  received: { label: 'Learning…', cls: 'bg-paper-deep text-ink-soft' },
  normalized: { label: 'Ready to review', cls: 'bg-tint-sky text-tint-sky-ink' },
  saved: { label: 'Saved · draft', cls: 'bg-paper-deep text-ink-soft' },
  active: { label: 'Saved · verified', cls: 'bg-success-soft text-success-ink' },
  failed: { label: 'Could not learn', cls: 'bg-danger-soft text-danger-ink' },
};

export function TeachView() {
  const [items, setItems] = useState<RecItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecDetail | null>(null);
  const [busy, setBusy] = useState<'load' | 'save' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { recordings } = await json<{ recordings: RecItem[] }>(await fetch('/api/teach/recordings', { cache: 'no-store' }));
      setItems(recordings);
      setSelected((s) => s ?? recordings[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load recordings');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    setDetail(null);
    setRunId(null);
    setBusy('load');
    fetch(`/api/teach/recordings/${selected}?normalize=1`, { cache: 'no-store' })
      .then((r) => json<RecDetail>(r))
      .then((d) => live && setDetail(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not load this recording'))
      .finally(() => live && setBusy(null));
    return () => {
      live = false;
    };
  }, [selected]);

  const save = async () => {
    if (!detail) return;
    setBusy('save');
    setError(null);
    try {
      const { skillId } = await json<{ skillId: string }>(
        await fetch(`/api/teach/recordings/${detail.id}/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      );
      setDetail({ ...detail, skillId, status: 'saved', skillStatus: 'draft' });
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  };

  const tryIt = async (skillId: string) => {
    setBusy('run');
    setError(null);
    try {
      const { runId } = await json<{ runId: string }>(
        await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skillId }) }),
      );
      setRunId(runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the run');
    } finally {
      setBusy(null);
    }
  };

  const draft = detail?.normalized ?? null;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 sm:px-8">
      <header className="flex items-center justify-between py-6 sm:py-8">
        <Wordmark />
        <Link href="/" className="inline-flex h-9 items-center rounded-full px-3 text-[14px] text-ink-soft hover:bg-ink/5 hover:text-ink">
          Home
        </Link>
      </header>

      <section className="pt-6 pb-10 sm:pt-12">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-faint">Teach Mode</p>
        <h1 className="mt-4 max-w-3xl font-display text-[44px] leading-[1.02] text-ink sm:text-[68px]">
          Teach your agent a <em className="text-ink-soft">new chore.</em>
        </h1>
        <ol className="mt-8 grid gap-3 sm:grid-cols-3">
          {[
            ['Install the extension', 'Open chrome://extensions, turn on Developer mode, click Load unpacked and pick the extension/ folder (see extension/README.md).'],
            ['Record it once', 'Click Start recording, do the chore as usual, then Stop and Send to Do It Once.'],
            ['Review and save', 'Your agent turns the recording into intent steps. Check them, save, and try it.'],
          ].map(([t, d], i) => (
            <li key={t} className="rounded-2xl border border-line/70 bg-card p-5 shadow-card">
              <span className="flex size-8 items-center justify-center rounded-full bg-paper-deep font-display text-lg">{i + 1}</span>
              <p className="mt-3 text-[15px] font-medium text-ink">{t}</p>
              <p className="mt-1 text-[14px] leading-relaxed text-ink-soft">{d}</p>
            </li>
          ))}
        </ol>
      </section>

      {error && (
        <p role="alert" className="mb-4 rounded-2xl bg-danger-soft px-4 py-3 text-[14px] text-danger-ink">
          {error}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div>
          <SectionLabel right={<span className="text-[12px] text-ink-faint">updates live</span>}>Recordings</SectionLabel>
          {items === null ? (
            <div className="skeleton h-24 rounded-card" />
          ) : items.length === 0 ? (
            <p className="rounded-card border border-dashed border-line-strong px-5 py-8 text-center text-[14px] text-ink-soft">
              No recordings yet. Send one from the extension.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((r) => {
                const st = STATUS[r.skillStatus === 'active' ? 'active' : r.status];
                return (
                  <li key={r.id}>
                    <button
                      onClick={() => setSelected(r.id)}
                      className={`w-full rounded-2xl border px-4 py-3 text-left transition-colors ${selected === r.id ? 'border-ink bg-card shadow-card' : 'border-line/70 bg-card/60 hover:bg-card'}`}
                    >
                      <p className="truncate text-[15px] font-medium text-ink">{r.title ?? host(r.startUrl)}</p>
                      <p className="mt-0.5 text-[12px] text-ink-faint">
                        {r.actionCount} actions · {time(r.createdAt)}
                      </p>
                      <span className={`mt-2 inline-block rounded-full px-2.5 py-0.5 text-[12px] font-medium ${st.cls}`}>{st.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          {!selected ? null : busy === 'load' || !detail ? (
            <Card className="flex items-center gap-3 p-8 text-[15px] text-ink-soft">
              <Spinner /> Your agent is turning this recording into a skill…
            </Card>
          ) : !draft ? (
            <Card className="p-8">
              <p className="font-display text-2xl">Could not learn this chore</p>
              <p className="mt-2 text-[14px] text-ink-soft">{detail.error ?? 'Try recording it again.'}</p>
            </Card>
          ) : (
            <Card className="animate-fade-up p-6 sm:p-8">
              <div className="flex items-start gap-4">
                <SkillIcon icon={draft.icon} />
                <div className="min-w-0 flex-1">
                  <h2 className="font-display text-[34px] leading-tight text-ink">{draft.title}</h2>
                  <p className="mt-1 text-[15px] text-ink-soft">{draft.description}</p>
                  <p className="mt-1 text-[12px] text-ink-faint">{draft.targetDomains.join(', ')}</p>
                </div>
              </div>

              <SectionLabel>
                <span className="mt-8 block">How your agent will do it</span>
              </SectionLabel>
              <ol className="flex flex-col">
                {draft.steps.map((s) => (
                  <li key={s.sequence} className="flex gap-4 border-t border-line py-3 first:border-t-0">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-paper-deep font-display text-base">{s.sequence}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-[15px] font-medium text-ink">{s.intent}</p>
                        {s.requiresApproval && (
                          <span className="rounded-full bg-approve-soft px-2.5 py-0.5 text-[12px] font-medium text-approve-ink">
                            Approval required{s.config.approval?.title ? ` · ${s.config.approval.title}` : ''}
                          </span>
                        )}
                        {s.config.askUser === true && (
                          <span className="rounded-full bg-paper-deep px-2.5 py-0.5 text-[12px] text-ink-soft">Asks you at run time</span>
                        )}
                      </div>
                      {s.targetDescription && <p className="mt-0.5 text-[13px] text-ink-soft">{s.targetDescription}</p>}
                      {s.expectedAfter && <p className="mt-0.5 text-[12px] text-ink-faint">Checks for: {s.expectedAfter.split('|').join(' or ')}</p>}
                    </div>
                  </li>
                ))}
              </ol>

              <div className="mt-6 grid gap-6 md:grid-cols-2">
                <div>
                  <SectionLabel>When to use it</SectionLabel>
                  <ul className="flex flex-wrap gap-2">
                    {draft.triggers.map((t) => (
                      <li key={t} className="rounded-full bg-paper-deep px-3 py-1 text-[13px] text-ink">
                        “{t}”
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <SectionLabel>Preferences</SectionLabel>
                  {Object.keys(draft.preferences).length ? (
                    <dl className="text-[14px]">
                      {Object.entries(draft.preferences).map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-3 py-1">
                          <dt className="text-ink-soft">{humanKey(k)}</dt>
                          <dd className="font-medium text-ink">{v === true ? 'Yes' : v === false ? 'No' : String(v)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="text-[14px] text-ink-faint">None learned.</p>
                  )}
                </div>
              </div>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                {!detail.skillId ? (
                  <Button onClick={save} busy={busy === 'save'}>
                    Save skill
                  </Button>
                ) : (
                  <>
                    <Button onClick={() => tryIt(detail.skillId!)} busy={busy === 'run'}>
                      Try it now
                    </Button>
                    <Link href={`/skills/${detail.skillId}`} className="text-[14px] text-ink-soft underline-offset-4 hover:underline">
                      Open skill
                    </Link>
                  </>
                )}
                <span className="text-[13px] text-ink-faint">
                  {detail.skillStatus === 'active'
                    ? 'Verified on the real website.'
                    : 'Saved as a draft until its first verified run.'}
                </span>
              </div>
            </Card>
          )}

          {runId && (
            <section className="mt-6" aria-label="Active run">
              <RunPanel key={runId} runId={runId} onRetry={(skillId) => void tryIt(skillId)} onSettled={() => void refresh()} />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
