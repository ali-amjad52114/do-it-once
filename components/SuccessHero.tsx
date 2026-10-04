'use client';
import type { RunResult } from '@/lib/contracts';

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n % 1 === 0 ? 0 : 2 });

export function SuccessHero({ result, word }: { result: RunResult; word: string }) {
  return (
    <section
      aria-live="polite"
      className="animate-fade-up relative overflow-hidden rounded-card border border-success/20 bg-card px-6 py-12 text-center shadow-lift sm:px-10 sm:py-16"
    >
      <div
        className="pointer-events-none absolute inset-x-0 -top-40 mx-auto h-80 w-[36rem] max-w-full rounded-full bg-success-soft blur-3xl"
        aria-hidden
      />
      <div className="relative">
        <div className="mx-auto flex size-24 items-center justify-center rounded-full bg-success text-white shadow-[0_18px_40px_-14px_rgb(5_150_105/0.7)] animate-pop sm:size-28">
          <svg viewBox="0 0 24 24" className="size-12 sm:size-14" aria-hidden>
            <path
              d="M5 12.5l4.5 4.5L19 7.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="48"
              className="animate-draw"
            />
          </svg>
        </div>
        <h2 className="mt-8 font-display text-[64px] uppercase leading-none tracking-[0.02em] text-ink sm:text-[112px]">
          {word}
        </h2>
        {result.valuePerYear != null && result.valuePerYear > 0 && (
          <p className="mt-5 text-xl text-success-ink sm:text-2xl">
            <span className="font-semibold">{money(result.valuePerYear)}/year</span> no longer recurring
          </p>
        )}
        {word === 'Return started' && <p className="mt-5 text-xl text-success-ink sm:text-2xl"><span className="font-semibold">{result.evidenceText.join(' ').match(/\$[\d,]+\.\d{2}/)?.[0] ?? 'Your'} refund</span> on its way</p>}
        <p className="mx-auto mt-4 max-w-lg text-[15px] leading-relaxed text-ink-soft">{result.summary}</p>
      </div>
    </section>
  );
}
