import Link from 'next/link';

export function Wordmark({ href = '/' }: { href?: string }) {
  return (
    <Link href={href} className="group inline-flex items-center gap-2.5 text-ink" aria-label="Do It Once — home">
      <span className="flex size-8 items-center justify-center rounded-full bg-ink text-paper transition-transform duration-300 group-hover:rotate-[-8deg]">
        <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
          <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="font-display text-[26px] leading-none tracking-tight">Do It Once</span>
    </Link>
  );
}
