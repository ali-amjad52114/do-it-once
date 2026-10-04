import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-faint">{children}</h2>
      {right}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-card border border-line/70 bg-card shadow-card ${className}`}>{children}</div>
  );
}

type Variant = 'primary' | 'secondary' | 'approve' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-ink text-white hover:bg-ink/90 shadow-[0_6px_16px_-8px_rgb(27_26_23/0.6)]',
  approve: 'bg-approve text-white hover:brightness-95 shadow-[0_8px_20px_-10px_rgb(217_119_6/0.8)]',
  secondary: 'bg-card text-ink border border-line-strong hover:bg-paper',
  ghost: 'text-ink-soft hover:text-ink hover:bg-ink/5',
};

export function Button({
  variant = 'primary',
  busy,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-[15px] font-medium transition-all duration-200 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${VARIANTS[variant]} ${className}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`${className} animate-spin`} aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Dot({ className = '' }: { className?: string }) {
  return <span className={`inline-block size-1 rounded-full bg-current opacity-40 ${className}`} aria-hidden />;
}
