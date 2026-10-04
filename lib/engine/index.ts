// Run engine entry point. Server-only: the `RunEngine` contract backed by the Mastra `choreRun`
// workflow registered on the app's Mastra instance (Neon PostgresStore + observability).
import type { RunEngine } from '@/lib/contracts';
import { flushTraces, getMastra } from '@/lib/mastra';
import { getRunCore } from '@/lib/engine/runtime';
import { createMastraRunEngine, type RunEngineWithIdle } from '@/lib/engine/engine';

export { createRunEngine, createMastraRunEngine, createRunCore, traceIdForRun } from '@/lib/engine/engine';
export type { EngineRepo, RunCore, RunEngineDeps, RunEngineWithIdle } from '@/lib/engine/engine';

const KEY = '__doItOnceRunEngine' as const;
type G = typeof globalThis & { [KEY]?: RunEngineWithIdle };

/** One engine per server process (survives Next.js dev hot reloads), so the active-run guard is shared. */
export function getRunEngine(): RunEngine {
  return getRunEngineWithIdle();
}

/** Same engine, plus `whenIdle(runId)` — for scripts that must wait for background work before exiting. */
export function getRunEngineWithIdle(): RunEngineWithIdle {
  const g = globalThis as G;
  g[KEY] ??= createMastraRunEngine({
    core: getRunCore(),
    workflow: () => getMastra().getWorkflow('choreRun'),
    flushTraces,
  });
  return g[KEY];
}
