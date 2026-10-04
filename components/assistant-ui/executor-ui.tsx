'use client';
// Chat renderers for the agent's Executor tools (lib/mastra/agents/chore-agent.ts: executorSearch, executorInvoke)
// plus a generic fallback so no tool call is ever invisible in the thread.
import { useState } from 'react';
import { useAui, type ToolCallMessagePartProps } from '@assistant-ui/react';
import { Spinner } from '@/components/ui';

type Hit = { id: string; integration: string | null; description: string; writes: boolean };
type SearchResult = { tools: Hit[]; error?: string };
type InvokeArgs = { toolId?: string; arguments?: Record<string, unknown>; confirmationId?: string };
type InvokeResult =
  | { ok: true; toolId: string; result: unknown }
  | { ok: false; needsConfirmation: true; toolId: string; confirmationId: string; message: string }
  | { ok: false; toolId: string; error: string };

const NAMES: Record<string, string> = {
  google_gmail: 'Gmail',
  google_calendar: 'Google Calendar',
  google_drive: 'Google Drive',
  google_docs: 'Google Docs',
  google_sheets: 'Google Sheets',
  google_tasks: 'Google Tasks',
  tomorrow_io_weather: 'Tomorrow.io',
  kiwi_com: 'Kiwi.com',
  deepwiki_com: 'DeepWiki',
};

/** "google_gmail" → "Gmail", "realtor_com" → "Realtor", "vivid_seats" → "Vivid Seats". */
export function integrationName(slug: string | null | undefined): string {
  if (!slug) return 'Executor';
  if (NAMES[slug]) return NAMES[slug];
  return slug
    .replace(/_(com|io|ai|app|co)$/, '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const integrationOf = (toolId?: string) => /^tools\.([^.]+)\./.exec(toolId ?? '')?.[1] ?? null;

/** "tools.google_gmail.user.x.gmail.users.messages.send" → "messages send". */
export function actionName(toolId?: string): string {
  if (!toolId) return 'tool';
  const parts = toolId.split('.').slice(4);
  const tail = (parts.length > 2 ? parts.slice(-2) : parts).join(' ');
  return tail.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() || 'tool';
}

const Bolt = () => (
  <svg viewBox="0 0 24 24" className="size-3.5 shrink-0" aria-hidden>
    <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12l1-8Z" fill="currentColor" />
  </svg>
);

function Chip({ tone = 'soft', children }: { tone?: 'soft' | 'pending' | 'error' | 'outline'; children: React.ReactNode }) {
  const cls = {
    soft: 'bg-paper-deep text-ink-soft',
    pending: 'border border-line text-ink-faint',
    error: 'bg-danger-soft text-danger-ink',
    outline: 'border border-dashed border-line-strong text-ink-soft',
  }[tone];
  return (
    <span className={`inline-flex max-w-full animate-fade-up flex-wrap items-center gap-1.5 rounded-full px-3 py-1 text-[13px] ${cls}`}>
      {tone === 'pending' && <Spinner className="size-3" />}
      {children}
    </span>
  );
}

// ── executorSearch

export function ExecutorSearchUI({ args, result, status }: ToolCallMessagePartProps<{ query?: string }, SearchResult>) {
  if (!result && status.type === 'incomplete') return <Chip tone="error">Couldn’t search your connected apps</Chip>;
  if (!result) return <Chip tone="pending">Searching your connected apps{args?.query ? ` for “${args.query}”` : ''}…</Chip>;
  if (result.error) return <Chip tone="error">Executor: {result.error.slice(0, 120)}</Chip>;
  if (!result.tools.length) return <Chip tone="outline">No connected app can do “{args?.query}” yet</Chip>;
  const apps = [...new Set(result.tools.map((t) => integrationName(t.integration)))];
  return (
    <div className="flex animate-fade-up flex-col gap-1.5">
      <Chip>
        <Bolt />
        Found {result.tools.length} tool{result.tools.length === 1 ? '' : 's'} in{' '}
        <span className="font-medium text-ink">{apps.slice(0, 3).join(', ')}</span>
        {apps.length > 3 && <span className="text-ink-faint">+{apps.length - 3}</span>}
      </Chip>
      <div className="flex flex-wrap gap-1 pl-1">
        {result.tools.slice(0, 5).map((t) => (
          <span key={t.id} title={t.description} className="rounded-md bg-card px-2 py-0.5 text-[12px] text-ink-faint ring-1 ring-line">
            {integrationName(t.integration)} · {actionName(t.id)}
            {t.writes && <span className="ml-1 text-approve-ink">writes</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── executorInvoke

function ConfirmCard({ toolId, confirmationId, args }: { toolId: string; confirmationId: string; args?: Record<string, unknown> }) {
  const aui = useAui();
  const [sent, setSent] = useState<'yes' | 'no' | null>(null);
  const reply = (yes: boolean) => {
    setSent(yes ? 'yes' : 'no');
    aui.thread().append(yes ? `Yes, go ahead with that. (confirm:${confirmationId})` : 'No, don’t do that.');
  };
  const preview = Object.entries(args ?? {})
    .filter(([, v]) => v !== undefined && v !== '')
    .slice(0, 4);
  return (
    <div className="w-full max-w-md animate-fade-up overflow-hidden rounded-2xl border border-approve/30 bg-approve-soft">
      <div className="h-1 bg-approve" aria-hidden />
      <div className="space-y-3 p-4">
        <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-approve-ink">Your OK needed</p>
        <p className="text-[15px] text-ink">
          {integrationName(integrationOf(toolId))}: <span className="font-medium">{actionName(toolId)}</span>
        </p>
        {preview.length > 0 && (
          <dl className="space-y-1 text-[13px]">
            {preview.map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="shrink-0 text-ink-faint">{k}</dt>
                <dd className="truncate text-ink-soft">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
        )}
        {sent ? (
          <p className="text-[13px] text-ink-soft">{sent === 'yes' ? 'Approved. Your agent is doing it now.' : 'Cancelled. Nothing was changed.'}</p>
        ) : (
          <div className="flex gap-2">
            <button onClick={() => reply(true)} className="rounded-full bg-ink px-4 py-1.5 text-[13px] text-white hover:bg-ink/90">
              Approve
            </button>
            <button onClick={() => reply(false)} className="rounded-full border border-line-strong bg-card px-4 py-1.5 text-[13px] text-ink-soft hover:bg-paper">
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ResultCard({ toolId, result }: { toolId: string; result: unknown }) {
  const [open, setOpen] = useState(false);
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return (
    <div className="w-full max-w-xl animate-fade-up rounded-2xl border border-line bg-card shadow-card">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px]">
        <span className="size-2 rounded-full bg-success" aria-hidden />
        <span className="text-ink">
          {integrationName(integrationOf(toolId))} · <span className="text-ink-soft">{actionName(toolId)}</span>
        </span>
        <span className="ml-auto text-ink-faint">{open ? 'Hide' : 'Show'} result</span>
      </button>
      {open && (
        <pre className="max-h-72 overflow-auto border-t border-line px-4 py-3 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-soft">
          {text}
        </pre>
      )}
    </div>
  );
}

export function ExecutorInvokeUI({ args, result, status }: ToolCallMessagePartProps<InvokeArgs, InvokeResult>) {
  const label = `${integrationName(integrationOf(args?.toolId))} · ${actionName(args?.toolId)}`;
  if (!result && status.type === 'incomplete') return <Chip tone="error">Couldn’t run {label}</Chip>;
  if (!result) return <Chip tone="pending">Running {label}…</Chip>;
  if (result.ok) return <ResultCard toolId={result.toolId} result={result.result} />;
  if ('needsConfirmation' in result) return <ConfirmCard toolId={result.toolId} confirmationId={result.confirmationId} args={args?.arguments} />;
  return <Chip tone="error">{label} failed: {result.error.slice(0, 140)}</Chip>;
}

// ── fallback for tools without a dedicated renderer

export function ToolFallbackChip({ toolName, status }: { toolName: string; status: { type: string } }) {
  const name = toolName.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  if (status.type === 'running') return <Chip tone="pending">Using {name}…</Chip>;
  if (status.type === 'incomplete') return <Chip tone="error">{name} didn’t finish</Chip>;
  return (
    <Chip>
      <Bolt />
      Used {name}
    </Chip>
  );
}
