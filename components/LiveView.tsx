'use client';
import { useEffect, useState } from 'react';

/** Appends `readOnly=true` to a Kernel live view URL (keeps any existing query). */
export function readOnlyUrl(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}readOnly=true`;
}

export function LiveView({
  url,
  ended,
  caption,
}: {
  url: string | null;
  /** The run finished, so the browser is gone. */
  ended?: boolean;
  caption?: string;
}) {
  const [loadedBase, setLoadedBase] = useState<string | null>(null);
  const src = url ? readOnlyUrl(url) : null;
  // Only the page identity (without query) decides whether we show the skeleton again.
  const base = src ? src.split('?')[0] : null;
  const loaded = !!base && loadedBase === base;
  const live = !!src && !ended;

  // Some embeds never fire onLoad cross-origin in time; don't hold the skeleton forever.
  useEffect(() => {
    if (!base) return;
    const t = setTimeout(() => setLoadedBase(base), 4000);
    return () => clearTimeout(t);
  }, [base]);

  return (
    <figure className="m-0">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-[13px] font-medium text-ink-soft">
          <span className="relative flex size-2">
            {live && <span className="absolute inset-0 animate-ping-soft rounded-full bg-live" />}
            <span className={`relative size-2 rounded-full ${live ? 'bg-live' : 'bg-line-strong'}`} />
          </span>
          Live browser
        </span>
        {caption && <span className="truncate text-[12px] text-ink-faint">{caption}</span>}
      </div>
      <div className="relative aspect-[16/10] w-full overflow-hidden rounded-2xl border border-line bg-paper-deep shadow-[inset_0_1px_0_rgb(255_255_255/0.6)]">
        {src && !ended && (
          <iframe
            src={src}
            title="Live view of the agent's browser"
            allow="autoplay; clipboard-read; clipboard-write"
            onLoad={() => setLoadedBase(base)}
            className={`absolute inset-0 size-full border-0 bg-white transition-opacity duration-500 ${
              loaded ? 'opacity-100' : 'opacity-0'
            }`}
          />
        )}
        {(!loaded || ended) && <BrowserSkeleton message={ended ? 'Browser closed' : src ? 'Connecting…' : 'Opening a secure browser…'} still={ended} />}
      </div>
    </figure>
  );
}

function BrowserSkeleton({ message, still }: { message: string; still?: boolean }) {
  const bar = still ? 'bg-line' : 'skeleton';
  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-card/70 px-3 py-2.5">
        <span className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-line-strong" />
          <span className="size-2.5 rounded-full bg-line-strong" />
          <span className="size-2.5 rounded-full bg-line-strong" />
        </span>
        <span className={`ml-2 h-5 flex-1 rounded-full ${bar}`} />
      </div>
      <div className="flex flex-1 gap-4 p-4 sm:p-6">
        <div className="hidden w-1/4 flex-col gap-3 sm:flex">
          <span className={`h-3 w-3/4 rounded-full ${bar}`} />
          <span className={`h-3 w-1/2 rounded-full ${bar}`} />
          <span className={`h-3 w-2/3 rounded-full ${bar}`} />
        </div>
        <div className="flex flex-1 flex-col gap-3">
          <span className={`h-5 w-1/2 rounded-full ${bar}`} />
          <span className={`h-3 w-5/6 rounded-full ${bar}`} />
          <span className={`h-3 w-2/3 rounded-full ${bar}`} />
          <span className={`mt-2 h-16 w-full rounded-xl ${bar}`} />
        </div>
      </div>
      <p className="absolute inset-x-0 bottom-4 text-center text-[13px] text-ink-faint">{message}</p>
    </div>
  );
}
