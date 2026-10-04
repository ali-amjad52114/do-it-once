'use client';
import { useState } from 'react';

export function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the text is still selectable */
    }
  };
  return (
    <div className="overflow-hidden rounded-tile border border-line bg-paper">
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <span className="text-[12px] font-medium text-ink-faint">{label}</span>
        <button
          onClick={copy}
          className="inline-flex h-7 items-center rounded-full px-3 text-[12px] text-ink-soft transition-colors hover:bg-ink/5 hover:text-ink"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 text-[13px] leading-relaxed text-ink">
        <code>{text}</code>
      </pre>
    </div>
  );
}
