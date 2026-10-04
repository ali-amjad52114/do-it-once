// Run engine entry point (B3). Server-only: wires the real repo, Kernel adapter and evidence modules.
import type { RunEngine } from '@/lib/contracts';
import * as repo from '@/lib/neon/repo';
import { getBrowserAdapter } from '@/lib/kernel';
import { verifyPage } from '@/lib/engine/verify';
import { extractApprovalPayload } from '@/lib/engine/extract';
import { createRunEngine, type RunEngineWithIdle } from '@/lib/engine/engine';

export { createRunEngine } from '@/lib/engine/engine';
export type { EngineRepo, RunEngineDeps, RunEngineWithIdle } from '@/lib/engine/engine';

const KEY = '__doItOnceRunEngine' as const;
type G = typeof globalThis & { [KEY]?: RunEngineWithIdle };

/** One engine per server process (survives Next.js dev hot reloads), so the active-run guard is shared. */
export function getRunEngine(): RunEngine {
  const g = globalThis as G;
  if (!g[KEY]) {
    g[KEY] = createRunEngine({
      repo,
      browser: getBrowserAdapter(),
      verify: verifyPage,
      extract: extractApprovalPayload,
    });
  }
  return g[KEY];
}
