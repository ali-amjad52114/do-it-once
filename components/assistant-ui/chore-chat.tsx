'use client';
// Assistant UI building blocks for the chore agent: runtime provider, composer and message list.
// Runtime = AI SDK v7 chat (`useChatRuntime`) → POST /api/chat → Mastra `choreAgent` on Neon AI Gateway.
import type { ReactNode } from 'react';
import {
  AssistantRuntimeProvider,
  AuiConfig,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  Tools,
  type EnrichedPartState,
} from '@assistant-ui/react';
import { useChatRuntime } from '@assistant-ui/ai-sdk';
import { choreToolkit } from './chore-toolkit';
import { ToolFallbackChip } from './executor-ui';
import { RunStartedContext, type RunStartedHandler } from './run-context';

/** Approve buttons send "(confirm:<code>)" for the server; hide it from the transcript. */
const stripConfirmCodes = (text: string) => text.replace(/\s*\(confirm:[a-f0-9]{10}\)/g, '');

const CONFIG = AuiConfig({ tools: Tools({ toolkit: choreToolkit }) });

export function ChoreChatProvider({ children, run }: { children: ReactNode; run: RunStartedHandler }) {
  const runtime = useChatRuntime();
  return (
    <RunStartedContext.Provider value={run}>
      <AssistantRuntimeProvider runtime={runtime} config={CONFIG}>
        {children}
      </AssistantRuntimeProvider>
    </RunStartedContext.Provider>
  );
}

// ── Composer

const ArrowUp = () => (
  <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
    <path d="M12 19V5m0 0-6 6m6-6 6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const StopSquare = () => (
  <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden>
    <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
  </svg>
);

export function ChatComposer({ placeholder, size = 'md', autoFocus }: { placeholder: string; size?: 'md' | 'lg'; autoFocus?: boolean }) {
  const lg = size === 'lg';
  return (
    <ComposerPrimitive.Root
      className={`group flex w-full items-end gap-2 rounded-[1.75rem] border border-line-strong/80 bg-card p-2 pl-5 shadow-card transition-shadow focus-within:border-ink/30 focus-within:shadow-lift ${lg ? 'min-h-16' : 'min-h-14'}`}
    >
      <ComposerPrimitive.Input
        rows={1}
        autoFocus={autoFocus}
        submitMode="enter"
        placeholder={placeholder}
        aria-label="Tell your agent what to do"
        className={`max-h-40 min-h-10 flex-1 resize-none self-center bg-transparent py-2 text-ink outline-none placeholder:text-ink-faint ${lg ? 'text-[17px]' : 'text-[16px]'}`}
      />
      <AuiIf condition={(s) => !s.thread.isRunning}>
        <ComposerPrimitive.Send
          aria-label="Send"
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-ink text-white transition-all hover:bg-ink/90 active:scale-95 disabled:bg-ink/15 disabled:text-ink-faint"
        >
          <ArrowUp />
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.isRunning}>
        <ComposerPrimitive.Cancel
          aria-label="Stop"
          className="flex size-10 shrink-0 items-center justify-center rounded-full border border-line-strong bg-card text-ink-soft transition-colors hover:bg-paper"
        >
          <StopSquare />
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </ComposerPrimitive.Root>
  );
}

// ── Messages

function Part({ part }: { part: EnrichedPartState }) {
  if (part.type === 'text') {
    const text = stripConfirmCodes(part.text);
    if (!text.trim()) return null;
    // Replies are plain text; the model occasionally adds **bold**, so render just that.
    return (
      <p className="whitespace-pre-wrap">
        {text.split(/\*\*(.+?)\*\*/g).map((t, i) => (i % 2 ? <strong key={i} className="font-semibold">{t}</strong> : t))}
      </p>
    );
  }
  if (part.type === 'tool-call')
    return <div className="py-0.5">{part.toolUI ?? <ToolFallbackChip toolName={part.toolName} status={part.status} />}</div>;
  if (part.type === 'reasoning' && part.text.trim())
    return (
      <details className="text-[13px] text-ink-faint">
        <summary className="cursor-pointer select-none">Thought it through</summary>
        <p className="mt-1 whitespace-pre-wrap border-l-2 border-line pl-3">{part.text}</p>
      </details>
    );
  return null;
}

const renderPart = ({ part }: { part: EnrichedPartState }) => <Part part={part} />;

function Thinking() {
  return (
    <AuiIf condition={(s) => s.thread.isRunning && s.message.isLast && !s.message.parts.some((p) => p.type === 'text' && p.text.trim())}>
      <span className="inline-flex items-center gap-1 py-1 text-ink-faint" aria-label="Thinking">
        <span className="size-1.5 animate-breathe rounded-full bg-current" />
        <span className="size-1.5 animate-breathe rounded-full bg-current [animation-delay:0.2s]" />
        <span className="size-1.5 animate-breathe rounded-full bg-current [animation-delay:0.4s]" />
      </span>
    </AuiIf>
  );
}

function UserMessage({ compact }: { compact: boolean }) {
  return (
    <MessagePrimitive.Root className="flex animate-fade-up justify-end">
      <div
        className={`max-w-[85%] rounded-[1.25rem] rounded-br-md bg-ink px-4 py-2 text-white ${compact ? 'text-[14px]' : 'text-[15px]'}`}
      >
        <MessagePrimitive.Parts>{renderPart}</MessagePrimitive.Parts>
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage({ compact }: { compact: boolean }) {
  return (
    <MessagePrimitive.Root className="flex animate-fade-up gap-3">
      <span
        aria-hidden
        className={`mt-0.5 flex shrink-0 items-center justify-center rounded-full bg-paper-deep font-display italic text-ink-soft ${compact ? 'size-6 text-[13px]' : 'size-7 text-[15px]'}`}
      >
        a
      </span>
      <div className={`flex min-w-0 flex-col items-start gap-1.5 leading-relaxed text-ink ${compact ? 'text-[14px]' : 'text-[15px]'}`}>
        <MessagePrimitive.Parts>{renderPart}</MessagePrimitive.Parts>
        <Thinking />
        <MessagePrimitive.Error>
          <p role="alert" className="rounded-xl bg-danger-soft px-3 py-1.5 text-[13px] text-danger-ink">
            Your agent couldn’t answer just now. Try again.
          </p>
        </MessagePrimitive.Error>
      </div>
    </MessagePrimitive.Root>
  );
}

const renderCompact = ({ message }: { message: { role: string } }) =>
  message.role === 'user' ? <UserMessage compact /> : <AssistantMessage compact />;
const renderFull = ({ message }: { message: { role: string } }) =>
  message.role === 'user' ? <UserMessage compact={false} /> : <AssistantMessage compact={false} />;

export function ChatMessages({ compact = false }: { compact?: boolean }) {
  return <ThreadPrimitive.Messages>{compact ? renderCompact : renderFull}</ThreadPrimitive.Messages>;
}

export function ChatSuggestion({ prompt, children }: { prompt: string; children?: ReactNode }) {
  return (
    <ThreadPrimitive.Suggestion
      prompt={prompt}
      send
      className="rounded-full border border-line bg-card/70 px-3.5 py-1.5 text-[13px] text-ink-soft transition-colors hover:border-line-strong hover:bg-card hover:text-ink"
    >
      {children ?? prompt}
    </ThreadPrimitive.Suggestion>
  );
}
