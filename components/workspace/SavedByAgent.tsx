'use client';
// "Saved by your agent": the post-action results under the success hero (agent R).
import { useEffect, useState } from 'react';
import { Card, SectionLabel, Spinner } from '../ui';

interface Saved {
  done: boolean;
  label: { artifactId?: string; path?: string; location?: string; fileName?: string; note?: string; mimeType?: string } | null;
  calendar: { via?: 'executor' | 'ics'; detail?: string; url?: string | null; artifactId?: string | null; title?: string; dateLabel?: string } | null;
  failures: string[];
}

export function SavedByAgent({ runId }: { runId: string }) {
  const [data, setData] = useState<Saved | null>(null);

  useEffect(() => {
    let alive = true;
    let tries = 0;
    const tick = async () => {
      try {
        const res = await fetch(`/api/workspace/runs/${runId}`, { cache: 'no-store' });
        if (res.ok) {
          const d = (await res.json()) as Saved;
          if (alive) setData(d);
          if (d.done) return;
        }
      } catch {
        /* retry */
      }
      if (alive && ++tries < 60) setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      alive = false;
    };
  }, [runId]);

  const label = data?.label;
  const cal = data?.calendar;
  return (
    <Card className="p-6 sm:p-7">
      <SectionLabel right={!data?.done ? <Spinner /> : undefined}>Saved by your agent</SectionLabel>
      <div className="grid gap-6 sm:grid-cols-[180px_minmax(0,1fr)]">
        <div className="flex aspect-[2/3] items-center justify-center overflow-hidden rounded-2xl border border-line bg-white">
          {label?.artifactId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/artifacts/${label.artifactId}`} alt="Return label with QR code" className="h-full w-full object-contain" />
          ) : (
            <span className="skeleton h-full w-full" />
          )}
        </div>
        <ul className="flex min-w-0 flex-col gap-4 text-[15px]">
          <li>
            <p className="font-medium text-ink">Return label</p>
            {label ? (
              <>
                <p className="mt-0.5 break-all font-mono text-[13px] text-ink-soft">
                  {label.location === 'sprite' ? `Fly Sprite · ${label.path}` : `${label.fileName} · kept in Neon (${label.note ?? 'Sprite not configured'})`}
                </p>
                {label.artifactId && (
                  <a className="mt-1 inline-block text-[14px] text-ink underline" href={`/api/artifacts/${label.artifactId}`} download={label.fileName}>
                    Download label
                  </a>
                )}
              </>
            ) : (
              <p className="text-ink-faint">Saving…</p>
            )}
          </li>
          <li>
            <p className="font-medium text-ink">Drop-off reminder</p>
            {cal ? (
              <>
                <p className="mt-0.5 text-ink-soft">
                  {cal.title} · {cal.dateLabel}
                </p>
                {cal.via === 'executor' ? (
                  cal.url ? (
                    <a className="mt-1 inline-block text-[14px] text-ink underline" href={cal.url} target="_blank" rel="noreferrer">
                      Added to Google Calendar ↗
                    </a>
                  ) : (
                    <p className="mt-1 text-[14px] text-success-ink">Added to Google Calendar</p>
                  )
                ) : cal.artifactId ? (
                  <a className="mt-1 inline-block text-[14px] text-ink underline" href={`/api/artifacts/${cal.artifactId}`} download="drop-off.ics">
                    Add to calendar (.ics)
                  </a>
                ) : null}
              </>
            ) : (
              <p className="text-ink-faint">Adding…</p>
            )}
          </li>
          {data?.failures.map((f) => (
            <li key={f} className="text-[13px] text-danger-ink">
              {f}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
