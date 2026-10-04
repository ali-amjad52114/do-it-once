'use client';
// Full-page chat with the chore agent (/chat). Runs started from the chat open in the live run panel.
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { AuiIf, ThreadPrimitive } from '@assistant-ui/react';
import { api } from '@/lib/client/api';
import { Wordmark } from '@/components/Brand';
import { RunPanel } from '@/components/RunPanel';
import { ChatComposer, ChatMessages, ChatSuggestion, ChoreChatProvider } from './chore-chat';

export function ChatPage() {
  const [runId, setRunId] = useState<string | null>(null);
  const run = useMemo(() => ({ onRunStarted: setRunId, where: 'on the right' }), []);

  const retry = useCallback(async (skillId: string, triggerId: string | null) => {
    const { runId } = await api.startRun({ skillId, triggerId });
    setRunId(runId);
  }, []);

  return (
    <ChoreChatProvider run={run}>
      <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 sm:px-8">
        <header className="flex items-center justify-between py-6 sm:py-8">
          <Wordmark />
          <Link
            href="/"
            className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] text-ink-faint transition-colors hover:bg-ink/5 hover:text-ink-soft"
          >
            <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden>
              <path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back home
          </Link>
        </header>

        <div className={`grid flex-1 gap-8 pb-10 ${runId ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]' : ''}`}>
          <ThreadPrimitive.Root className={`flex min-h-[60dvh] flex-col ${runId ? '' : 'mx-auto w-full max-w-2xl'}`}>
            <AuiIf condition={(s) => s.thread.isEmpty}>
              <div className="pt-6 pb-10 sm:pt-12">
                <h1 className="font-display text-[44px] leading-[1.05] tracking-[-0.01em] text-ink sm:text-[60px]">
                  What should your agent <em className="text-ink-soft">handle?</em>
                </h1>
                <p className="mt-4 max-w-lg text-[16px] leading-relaxed text-ink-soft">
                  Ask in your own words. Your agent finds the chore you taught it, and checks with you before anything you
                  can’t undo.
                </p>
                <div className="mt-6 flex flex-wrap gap-2">
                  <ChatSuggestion prompt="Get rid of this subscription" />
                  <ChatSuggestion prompt="What chores have I taught you?" />
                  <ChatSuggestion prompt="Can you book my haircut?" />
                  <ChatSuggestion prompt="What's the weather in San Francisco this weekend?" />
                  <ChatSuggestion prompt="Find flights from SFO to New York next Friday" />
                </div>
              </div>
            </AuiIf>

            <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-4 overflow-y-auto pb-6">
              <ChatMessages />
            </ThreadPrimitive.Viewport>

            <div className="bottom-0 bg-gradient-to-t [@media(min-height:640px)]:sticky from-paper via-paper to-paper/0 pt-4 pb-4">
              <ChatComposer size="lg" autoFocus placeholder="Tell your agent… e.g. Get rid of this subscription" />
            </div>
          </ThreadPrimitive.Root>

          {runId && (
            <section aria-label="Active run" className="min-w-0 lg:sticky lg:top-6 lg:self-start">
              <RunPanel key={runId} runId={runId} onRetry={retry} />
            </section>
          )}
        </div>
      </div>
    </ChoreChatProvider>
  );
}
