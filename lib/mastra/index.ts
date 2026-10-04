// CONTRACT STUB — owned by agent M1. The single Mastra instance (storage, observability,
// workflows from ./workflows, agents from ./agents). Server-only.
import { Mastra } from '@mastra/core/mastra';
import { agents } from './agents';
import { workflows } from './workflows';

const g = globalThis as typeof globalThis & { __doItOnceMastra?: Mastra };

export function getMastra(): Mastra {
  g.__doItOnceMastra ??= new Mastra({ agents, workflows });
  return g.__doItOnceMastra;
}
