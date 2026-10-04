import type { ReactNode } from 'react';

type Tint = { bg: string; fg: string };

const TINTS: Record<string, Tint> = {
  subscription: { bg: 'bg-tint-lilac', fg: 'text-tint-lilac-ink' },
  return: { bg: 'bg-tint-sand', fg: 'text-tint-sand-ink' },
  haircut: { bg: 'bg-tint-sky', fg: 'text-tint-sky-ink' },
  registration: { bg: 'bg-tint-slate', fg: 'text-tint-slate-ink' },
};

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const GLYPHS: Record<string, ReactNode> = {
  subscription: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" {...stroke} />
      <path d="M3 9.5h18" {...stroke} />
      <path d="M14.5 15.2a2.4 2.4 0 1 0 .6-2.6" {...stroke} />
      <path d="M15.4 11.6v1.3h-1.3" {...stroke} />
      <path d="M6.5 15h3" {...stroke} />
    </>
  ),
  return: (
    <>
      <path d="M12 3.5 19.5 7.5v9L12 20.5 4.5 16.5v-9L12 3.5Z" {...stroke} />
      <path d="M4.5 7.5 12 11.5l7.5-4M12 11.5v9" {...stroke} />
      <path d="M9.2 5.1l7.4 4" {...stroke} />
    </>
  ),
  haircut: (
    <>
      <circle cx="6.5" cy="17" r="2.6" {...stroke} />
      <circle cx="6.5" cy="7" r="2.6" {...stroke} />
      <path d="M8.7 8.4 20 17.5M8.7 15.6 20 6.5" {...stroke} />
    </>
  ),
  registration: (
    <>
      <path d="M5 16.5V12l1.8-4.2A2 2 0 0 1 8.6 6.5h6.8a2 2 0 0 1 1.8 1.3L19 12v4.5" {...stroke} />
      <rect x="3.5" y="12" width="17" height="5" rx="1.6" {...stroke} />
      <path d="M6 19.5v-2.5M18 19.5v-2.5M7.5 14.5h.01M16.5 14.5h.01M5.5 12h13" {...stroke} />
    </>
  ),
  default: (
    <>
      <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9L12 3.5Z" {...stroke} />
      <path d="M18.5 16v4M16.5 18h4" {...stroke} />
    </>
  ),
};

export function SkillIcon({ icon, size = 'md' }: { icon: string; size?: 'sm' | 'md' | 'lg' }) {
  const key = icon in GLYPHS ? icon : 'default';
  const tint = TINTS[key] ?? { bg: 'bg-tint-slate', fg: 'text-tint-slate-ink' };
  const box = size === 'lg' ? 'size-16 rounded-2xl' : size === 'sm' ? 'size-9 rounded-xl' : 'size-12 rounded-2xl';
  const svg = size === 'lg' ? 'size-8' : size === 'sm' ? 'size-5' : 'size-6';
  return (
    <span className={`inline-flex shrink-0 items-center justify-center ${box} ${tint.bg} ${tint.fg}`} aria-hidden>
      <svg viewBox="0 0 24 24" className={svg}>
        {GLYPHS[key]}
      </svg>
    </span>
  );
}
