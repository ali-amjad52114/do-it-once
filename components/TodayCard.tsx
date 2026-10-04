'use client';
import type { TodayItem } from '@/lib/contracts';
import { Button, Card, Dot } from './ui';

const AVATAR_TONES = ['bg-tint-lilac text-tint-lilac-ink', 'bg-tint-sky text-tint-sky-ink', 'bg-tint-sand text-tint-sand-ink'];

function MerchantMark({ name }: { name: string }) {
  const tone = AVATAR_TONES[name.charCodeAt(0) % AVATAR_TONES.length];
  return (
    <span
      className={`flex size-12 shrink-0 items-center justify-center rounded-2xl font-display text-2xl leading-none ${tone}`}
      aria-hidden
    >
      {name.replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '•'}
    </span>
  );
}

/** Where an item came from, when it was not seeded (e.g. an email in the agent's inbox). */
export interface TodaySource {
  label: string; // "From your inbox · Lumen+ Billing"
  detail?: string | null; // original email subject (tooltip)
}

export function TodayCard({
  item,
  source,
  active,
  busy,
  onRun,
}: {
  item: TodayItem;
  source?: TodaySource | null;
  /** A run for this item is currently in progress on the page. */
  active: boolean;
  busy: boolean;
  onRun: () => void;
}) {
  const done = item.state === 'done';
  const running = active || item.state === 'running';
  const meta = [item.merchant, item.amount, item.dueLabel].filter(Boolean) as string[];

  return (
    <Card className="animate-fade-up p-5 sm:p-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <MerchantMark name={item.merchant ?? item.title} />
          <div className="min-w-0">
            {source && (
              <p className="mb-1 flex items-center gap-1.5 text-[12px] text-ink-faint" title={source.detail ?? undefined}>
                <svg viewBox="0 0 24 24" className="size-3.5 shrink-0" aria-hidden>
                  <path
                    d="M4 6.5h16v11H4zM4.5 7l7.5 6 7.5-6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="truncate">{source.label}</span>
              </p>
            )}
            <p className="text-[17px] font-semibold tracking-tight text-ink">{item.title}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] text-ink-soft">
              {meta.map((m, i) => (
                <span key={m} className="inline-flex items-center gap-2">
                  {i > 0 && <Dot />}
                  <span className={m === item.amount ? 'font-medium text-ink' : ''}>{m}</span>
                </span>
              ))}
            </p>
            {item.matchedSkill ? (
              <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-paper-deep px-3 py-1 text-[13px] text-ink-soft">
                <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden>
                  <path
                    d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9L12 3.5Z"
                    fill="currentColor"
                  />
                </svg>
                {source ? 'Matching skill:' : 'Skill found:'} <span className="font-medium text-ink">{item.matchedSkill.title}</span>
              </p>
            ) : (
              <p className="mt-3 text-[13px] text-ink-faint">No skill yet. Do it once and your agent will learn it.</p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 sm:justify-end">
          {done ? (
            <span className="inline-flex h-11 items-center gap-2 rounded-full bg-success-soft px-5 text-[15px] font-medium text-success-ink">
              <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
                <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Handled
            </span>
          ) : running ? (
            <span className="inline-flex h-11 items-center gap-2.5 rounded-full border border-line px-5 text-[15px] text-ink-soft">
              <span className="relative flex size-2">
                <span className="absolute inset-0 animate-ping-soft rounded-full bg-live" />
                <span className="relative size-2 rounded-full bg-live" />
              </span>
              Agent on it
            </span>
          ) : item.matchedSkill ? (
            <Button onClick={onRun} busy={busy} className="w-full px-7 sm:w-auto">
              Run
              <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
                <path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
