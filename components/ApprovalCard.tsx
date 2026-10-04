'use client';
import type { Approval } from '@/lib/contracts';
import { Button } from './ui';

export function ApprovalCard({
  approval,
  busy,
  onApprove,
  onStop,
}: {
  approval: Approval;
  busy: 'approve' | 'stop' | null;
  onApprove: () => void;
  onStop: () => void;
}) {
  const { price, renewal, merchant } = approval.payload;
  const facts = [
    merchant ? { k: 'Merchant', v: merchant } : null,
    price ? { k: 'Price', v: price } : null,
    renewal ? { k: 'Renewal', v: renewal } : null,
  ].filter(Boolean) as { k: string; v: string }[];
  const isCancel = /cancel/i.test(approval.title);

  return (
    <section
      role="alertdialog"
      aria-labelledby="approval-title"
      aria-describedby="approval-desc"
      className="animate-fade-up overflow-hidden rounded-card border border-approve/30 bg-approve-soft shadow-lift"
    >
      <div className="h-1 w-full bg-approve" aria-hidden />
      <div className="p-5 sm:p-7">
        <p className="inline-flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-approve-ink">
          <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
            <path d="M12 3.5 21 19.5H3L12 3.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M12 10v4.2M12 16.8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Your OK needed
        </p>
        <h3 id="approval-title" className="mt-3 font-display text-[34px] leading-[1.05] text-ink sm:text-[44px]">
          {approval.title}
        </h3>
        <p id="approval-desc" className="mt-3 max-w-xl text-[15px] leading-relaxed text-ink-soft">
          {approval.description}
        </p>

        {facts.length > 0 && (
          <dl className="mt-5 grid grid-cols-1 divide-y divide-approve/15 overflow-hidden rounded-2xl bg-card/80 sm:grid-cols-3 sm:gap-2 sm:divide-y-0 sm:overflow-visible sm:rounded-none sm:bg-transparent">
            {facts.map((f) => (
              <div
                key={f.k}
                className="flex items-baseline justify-between gap-4 px-4 py-2.5 sm:block sm:rounded-2xl sm:bg-card/80 sm:py-3"
              >
                <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">{f.k}</dt>
                <dd className="text-right text-[15px] font-medium text-ink sm:mt-0.5 sm:text-left">{f.v}</dd>
              </div>
            ))}
          </dl>
        )}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button variant="approve" className="h-12 px-7 text-base" busy={busy === 'approve'} disabled={!!busy} onClick={onApprove}>
            {isCancel ? 'Approve cancellation' : 'Approve'}
          </Button>
          <Button variant="secondary" className="h-12 px-6" busy={busy === 'stop'} disabled={!!busy} onClick={onStop}>
            Stop
          </Button>
          <p className="text-[13px] text-ink-faint sm:ml-auto">Nothing happens until you decide.</p>
        </div>
      </div>
    </section>
  );
}
