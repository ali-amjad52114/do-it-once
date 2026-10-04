// Process-wide run core wired to the real repo (Neon), Kernel adapter and evidence modules.
// Server-only. The Mastra `choreRun` workflow steps and `getRunEngine()` share this one core,
// so the active-run guard and Stop flags are the same object (survives Next dev hot reloads).
import * as repo from '@/lib/neon/repo';
import { getBrowserAdapter } from '@/lib/kernel';
import { verifyPage } from '@/lib/engine/verify';
import { extractApprovalPayload } from '@/lib/engine/extract';
import { createRunCore, type RunCore } from '@/lib/engine/engine';

const KEY = '__doItOnceRunCore' as const;
type G = typeof globalThis & { [KEY]?: RunCore };

export function getRunCore(): RunCore {
  const g = globalThis as G;
  g[KEY] ??= createRunCore({
    repo,
    browser: getBrowserAdapter(),
    verify: verifyPage,
    extract: extractApprovalPayload,
  });
  return g[KEY];
}
