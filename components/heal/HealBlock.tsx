'use client';
import type { ExecutionEvent } from '@/lib/contracts';

/** Heal events (heal.*) for one run, or null when the run did not heal. */
export function healEvents(events: ExecutionEvent[]): ExecutionEvent[] | null {
  const list = events.filter((e) => e.type.startsWith('heal.'));
  return list.length ? list : null;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** "Website changed — re-learning the path": each heal.step, Exa sources and the final version note. */
export function HealBlock({ events }: { events: ExecutionEvent[] }) {
  const steps = events.filter((e) => e.type === 'heal.step');
  const research = events.find((e) => e.type === 'heal.research');
  const sources = (research?.metadata.sources as { url: string; title: string | null }[] | undefined) ?? [];
  const succeeded = events.find((e) => e.type === 'heal.succeeded');
  const failed = events.find((e) => e.type === 'heal.failed');
  return (
    <div className="mt-2 animate-fade-up rounded-tile border border-live/25 bg-tint-sky px-3.5 py-3 text-[13px] text-tint-sky-ink">
      <p className="font-semibold text-ink">Website changed — re-learning the path</p>
      <ul className="mt-1.5 space-y-1">
        {steps.map((e) => (
          <li key={e.id} className="flex gap-2">
            <span className="mt-[7px] block size-1.5 shrink-0 rounded-full bg-live" aria-hidden />
            <span>{e.message}</span>
          </li>
        ))}
        {!succeeded && !failed && steps.length === 0 && <li className="text-ink-faint">Looking at the live page…</li>}
      </ul>
      {research && (
        <p className="mt-2 text-ink-soft">
          Exa research: {String(research.metadata.summary ?? 'done')}
          {sources.slice(0, 3).map((s) => (
            <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="ml-2 underline">
              {s.title ?? host(s.url)}
            </a>
          ))}
        </p>
      )}
      {succeeded && <p className="mt-2 font-medium text-success-ink">{succeeded.message}</p>}
      {failed && <p className="mt-2 font-medium text-danger-ink">{failed.message}</p>}
    </div>
  );
}
