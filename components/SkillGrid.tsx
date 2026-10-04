'use client';
import Link from 'next/link';
import type { SkillSummary } from '@/lib/contracts';
import { withMock } from '@/lib/client/api';
import { SkillIcon } from './SkillIcon';

export const pct = (n: number) => `${Math.round(n * 100)}%`;
export const runsLabel = (n: number) => `${n} run${n === 1 ? '' : 's'}`;

export function SkillGrid({ skills }: { skills: SkillSummary[] | null }) {
  if (!skills) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-[160px] rounded-card" />
        ))}
      </div>
    );
  }
  if (skills.length === 0) {
    return (
      <p className="rounded-card border border-dashed border-line-strong px-6 py-10 text-center text-[15px] text-ink-soft">
        No skills yet. Do a chore once and your agent will remember how.
      </p>
    );
  }
  return (
    <ul className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      {skills.map((s, i) => (
        <li key={s.id} className="animate-fade-up" style={{ animationDelay: `${i * 60}ms` }}>
          <Link
            href={withMock(`/skills/${s.id}`)}
            className="group flex h-full flex-col rounded-card border border-line/70 bg-card p-4 shadow-card transition-all duration-300 sm:p-5 hover:-translate-y-0.5 hover:shadow-lift focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            <div className="flex items-start justify-between">
              <SkillIcon icon={s.icon} />
              <svg
                viewBox="0 0 24 24"
                className="size-5 text-ink-faint opacity-0 transition-all duration-300 group-hover:translate-x-0.5 group-hover:opacity-100"
                aria-hidden
              >
                <path d="M7 17 17 7M9 7h8v8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="mt-4 text-[16px] font-semibold leading-snug tracking-tight text-ink sm:mt-6 sm:text-[17px]">{s.title}</p>
            <p className="mt-1 text-[13px] text-ink-soft sm:text-[14px]">
              {s.status === 'draft' ? (
                'Not learned yet'
              ) : s.runCount === 0 ? (
                'Ready · no runs yet'
              ) : (
                <>
                  {runsLabel(s.runCount)} <span className="text-ink-faint">•</span> {pct(s.successRate)} success
                </>
              )}
            </p>
            <p className="mt-auto pt-4 text-[12px] text-ink-faint">
              {s.status === 'draft' ? 'Teach it once to start' : `v${s.version} · ${s.runCount ? `${pct(s.confidence)} confident` : 'learned'}`}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}
