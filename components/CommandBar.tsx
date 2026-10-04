'use client';
// Owned by agent M3 (Assistant UI chat). Props are fixed.
// The chat agent finds the matching skill for a plain-language request and starts a run;
// onRunStarted(runId) makes the home page show the live run panel.
import Link from 'next/link';
import { useMemo } from 'react';
import { AuiIf, ThreadPrimitive } from '@assistant-ui/react';
import { ChatComposer, ChatMessages, ChatSuggestion, ChoreChatProvider } from './assistant-ui/chore-chat';

export function CommandBar({ onRunStarted }: { onRunStarted: (runId: string) => void }) {
  const run = useMemo(() => ({ onRunStarted, where: 'below' }), [onRunStarted]);
  return (
    <ChoreChatProvider run={run}>
      <ThreadPrimitive.Root className="mt-10 w-full max-w-2xl">
        <ChatComposer placeholder="Tell your agent… e.g. Get rid of this subscription" />
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <div className="mt-3 flex flex-wrap items-center gap-2 pl-1">
            <ChatSuggestion prompt="Get rid of this subscription" />
            <ChatSuggestion prompt="What chores have I taught you?" />
            <Link href="/chat" className="ml-1 text-[13px] text-ink-faint underline-offset-4 hover:text-ink-soft hover:underline">
              Open full chat
            </Link>
          </div>
        </AuiIf>
        <AuiIf condition={(s) => !s.thread.isEmpty}>
          <ThreadPrimitive.Viewport className="mt-4 flex max-h-[22rem] flex-col gap-3 overflow-y-auto px-1 pb-1">
            <ChatMessages compact />
          </ThreadPrimitive.Viewport>
        </AuiIf>
      </ThreadPrimitive.Root>
    </ChoreChatProvider>
  );
}
