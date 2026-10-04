'use client';
import { createContext, useContext } from 'react';

export type RunStartedHandler = {
  onRunStarted: (runId: string) => void;
  /** Where the run panel is relative to the chat, e.g. "below" or "on the right". */
  where: string;
};

export const RunStartedContext = createContext<RunStartedHandler | null>(null);

export const useRunStarted = () => useContext(RunStartedContext);

/** Tool calls whose run was already handed to the page (survives re-renders and remounts). */
export const handledToolCalls = new Set<string>();
