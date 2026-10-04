// Owned by agent M1 (workflow). Export every Mastra workflow here; lib/mastra/index.ts registers them.
import { getRunCore } from '@/lib/engine/runtime';
import { createChoreRunWorkflow } from './chore-run';

/** Chore replay with a persisted approval gate. Steps resolve the process-wide run core lazily. */
export const choreRun = createChoreRunWorkflow(() => getRunCore());

export const workflows = { choreRun };
