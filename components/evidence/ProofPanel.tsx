'use client';
// Owned by agent B6 (Evidence). The "Proof" card: what the website itself showed after the run.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { RunResult } from '@/lib/contracts';

/** Outcome words that are worth highlighting inside an evidence snippet when no explicit highlight is given. */
const DEFAULT_HIGHLIGHT =
  /(membership canceled|membership cancelled|renews: no|access ends on [^.…]*|canceled|cancelled|confirmed|completed|success(?:ful(?:ly)?)?|booked|submitted|refund(?:ed)?)/gi;

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlight(snippet: string, phrases?: string[]): ReactNode[] {
  const re =
    phrases && phrases.length > 0
      ? new RegExp(`(${phrases.filter(Boolean).map(escapeRegExp).join('|')})`, 'gi')
      : DEFAULT_HIGHLIGHT;
  const parts = snippet.split(re);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded bg-emerald-100 px-0.5 font-semibold text-emerald-900">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function truncateMiddle(s: string, max = 64): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  return `${s.slice(0, Math.ceil(keep * 0.6))}…${s.slice(s.length - Math.floor(keep * 0.4))}`;
}

function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || 'Unknown time';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-4 w-4">
      <path
        fillRule="evenodd"
        d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-4 w-4">
      <path d="M5.7 4.3a1 1 0 0 0-1.4 1.4L8.6 10l-4.3 4.3a1 1 0 1 0 1.4 1.4L10 11.4l4.3 4.3a1 1 0 0 0 1.4-1.4L11.4 10l4.3-4.3a1 1 0 0 0-1.4-1.4L10 8.6 5.7 4.3Z" />
    </svg>
  );
}

function Screenshot({ artifactId }: { artifactId: string | null }) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close]);

  if (!artifactId || failed) {
    return (
      <div className="flex aspect-[16/10] w-full items-center justify-center rounded-xl border border-dashed border-stone-300 bg-stone-100/70 px-4 text-center text-xs text-stone-500">
        {artifactId ? 'Screenshot unavailable' : 'No screenshot was captured'}
      </div>
    );
  }

  const src = `/api/artifacts/${encodeURIComponent(artifactId)}`;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative block w-full overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        aria-label="Open screenshot full size"
      >
        <img
          src={src}
          alt="Screenshot of the final page"
          loading="lazy"
          onError={() => setFailed(true)}
          className="aspect-[16/10] w-full object-cover object-top transition duration-300 group-hover:scale-[1.02]"
        />
        <span className="absolute bottom-2 right-2 rounded-full bg-stone-900/75 px-2 py-0.5 text-[11px] font-medium text-white opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
          View full size
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Screenshot of the final page"
          onClick={close}
          className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/80 p-4 backdrop-blur-sm sm:p-8"
        >
          <button
            type="button"
            onClick={close}
            autoFocus
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            aria-label="Close screenshot"
          >
            <CrossIcon />
          </button>
          <img
            src={src}
            alt="Screenshot of the final page, full size"
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full rounded-lg shadow-2xl"
          />
        </div>
      )}
    </>
  );
}

export function ProofPanel({ result, highlightPhrases }: { result: RunResult; highlightPhrases?: string[] }) {
  const verified = result.success;
  const evidence = (result.evidenceText ?? []).filter((e) => e && e.trim());
  const quotes = evidence.filter((e) => !isUrl(e));
  const urlEvidence = evidence.filter((e) => isUrl(e) && e !== result.finalUrl);

  return (
    <section
      aria-label="Proof"
      className="w-full rounded-2xl border border-stone-200 bg-[#fbfaf7] p-5 shadow-[0_1px_2px_rgba(28,25,23,0.04),0_8px_24px_-12px_rgba(28,25,23,0.12)] sm:p-6"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-stone-500">Proof</h3>
        </div>
        <span
          className={
            verified
              ? 'inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20'
              : 'inline-flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1 text-sm font-medium text-red-700 ring-1 ring-inset ring-red-600/20'
          }
        >
          {verified ? <CheckIcon /> : <CrossIcon />}
          {verified ? 'Verified on the website' : 'Not verified'}
        </span>
      </header>

      <div className="mt-5 grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
        <div className="min-w-0 space-y-5">
          <div>
            <p className="mb-2 text-xs font-medium text-stone-500">
              {verified ? 'What the page said' : 'What we found on the page'}
            </p>
            {quotes.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {quotes.map((q, i) => (
                  <li
                    key={`${i}-${q}`}
                    className="max-w-full rounded-xl border border-stone-200 bg-white px-3 py-1.5 text-sm leading-relaxed text-stone-700 shadow-sm"
                  >
                    <span className="mr-0.5 text-stone-400" aria-hidden="true">
                      &ldquo;
                    </span>
                    {highlight(q, highlightPhrases)}
                    <span className="ml-0.5 text-stone-400" aria-hidden="true">
                      &rdquo;
                    </span>
                  </li>
                ))}
                {urlEvidence.map((u) => (
                  <li
                    key={u}
                    title={u}
                    className="max-w-full truncate rounded-xl border border-stone-200 bg-white px-3 py-1.5 font-mono text-xs text-stone-600 shadow-sm"
                  >
                    {truncateMiddle(displayUrl(u), 56)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-stone-500">
                {verified ? 'No text snippets were recorded.' : 'The expected confirmation text was not on the page.'}
              </p>
            )}
          </div>

          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs font-medium text-stone-500">Final page</dt>
              <dd className="mt-0.5 truncate font-mono text-xs text-stone-700" title={result.finalUrl}>
                {result.finalUrl ? truncateMiddle(displayUrl(result.finalUrl), 48) : '—'}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-medium text-stone-500">Checked</dt>
              <dd className="mt-0.5 text-stone-700">
                <time dateTime={result.verifiedAt} suppressHydrationWarning>
                  {formatTimestamp(result.verifiedAt)}
                </time>
              </dd>
            </div>
          </dl>
        </div>

        <div className="min-w-0">
          <p className="mb-2 text-xs font-medium text-stone-500">Screenshot</p>
          <Screenshot artifactId={result.screenshotArtifactId} />
        </div>
      </div>
    </section>
  );
}
