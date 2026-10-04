// The single Mastra instance (agent M1). Server-only.
// - storage: PostgresStore on DATABASE_URL (Neon) — workflow snapshots (suspend/resume across
//   restarts) and observability spans (mastra_* tables, created by Mastra on init)
// - observability: v1 `Observability` with MastraStorageExporter → every run produces a trace in Neon
// - workflows from ./workflows, agents from ./agents
import { Mastra } from '@mastra/core/mastra';
import { PostgresStore } from '@mastra/pg';
import {
  MastraPlatformExporter,
  MastraStorageExporter,
  Observability,
  SensitiveDataFilter,
} from '@mastra/observability';
import type { ObservabilityExporter } from '@mastra/core/observability';
import { traceIdForRun } from '@/lib/engine/engine';
import { agents } from './agents';
import { workflows } from './workflows';

const g = globalThis as typeof globalThis & { __doItOnceMastra?: Mastra };

function createMastra(): Mastra {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Missing env var DATABASE_URL (see .env.example)');

  const exporters: ObservabilityExporter[] = [new MastraStorageExporter({ maxBatchWaitMs: 1000 })];
  // Optional: also send traces to Mastra platform / Studio when a token is configured.
  if (process.env.MASTRA_PLATFORM_ACCESS_TOKEN) exporters.push(new MastraPlatformExporter());

  return new Mastra({
    agents,
    workflows,
    storage: new PostgresStore({ id: 'neon-mastra', connectionString }),
    observability: new Observability({
      configs: {
        default: {
          serviceName: 'do-it-once',
          exporters,
          spanOutputProcessors: [new SensitiveDataFilter()],
        },
      },
    }),
  });
}

export function getMastra(): Mastra {
  g.__doItOnceMastra ??= createMastra();
  return g.__doItOnceMastra;
}

/** Flushes buffered spans to storage (call before a short-lived process exits or before reading a trace). */
export async function flushTraces(): Promise<void> {
  await getMastra().observability.flush();
}

export interface RunTraceSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  spanType: string;
  entityType: string | null;
  entityId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  status: 'ok' | 'error' | 'running';
  error: string | null;
  metadata: Record<string, unknown> | null;
  input: unknown;
  output: unknown;
}

export interface RunTrace {
  runId: string;
  /** The Mastra workflow runId (= our skill_runs.id). */
  mastraRunId: string;
  traceId: string | null;
  spans: RunTraceSpan[];
}

type StoredSpan = Record<string, unknown>;

function iso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toSpan(s: StoredSpan): RunTraceSpan {
  const startedAt = iso(s.startedAt);
  const endedAt = iso(s.endedAt);
  const err = s.error as { message?: string } | null | undefined;
  return {
    spanId: String(s.spanId),
    parentSpanId: (s.parentSpanId as string | null) ?? null,
    name: String(s.name),
    spanType: String(s.spanType),
    entityType: (s.entityType as string | null) ?? null,
    entityId: (s.entityId as string | null) ?? null,
    startedAt,
    endedAt,
    durationMs: startedAt && endedAt ? new Date(endedAt).getTime() - new Date(startedAt).getTime() : null,
    status: err ? 'error' : endedAt ? 'ok' : 'running',
    error: err ? (err.message ?? JSON.stringify(err)) : null,
    metadata: (s.metadata as Record<string, unknown> | null) ?? null,
    input: s.input ?? null,
    output: s.output ?? null,
  };
}

/**
 * All spans for a run's Mastra workflow execution (start + every resume share one trace id derived
 * from the run id). Falls back to a runId filter for traces recorded under another trace id.
 */
export async function getRunTrace(runId: string): Promise<RunTrace> {
  const mastra = getMastra();
  await mastra.observability.flush().catch(() => undefined);
  const store = await mastra.getStorage()?.getStore('observability');
  if (!store) return { runId, mastraRunId: runId, traceId: null, spans: [] };

  const traceIds = new Set<string>();
  const primary = traceIdForRun(runId);
  if (primary) traceIds.add(primary);
  try {
    const listed = await store.listTraces({ filters: { runId } } as Parameters<typeof store.listTraces>[0]);
    for (const s of (listed as { spans?: StoredSpan[] }).spans ?? []) if (s.traceId) traceIds.add(String(s.traceId));
  } catch {
    /* listing is optional */
  }

  const spans: RunTraceSpan[] = [];
  const seen = new Set<string>();
  for (const traceId of traceIds) {
    const trace = await store.getTrace({ traceId });
    for (const s of (trace?.spans ?? []) as unknown as StoredSpan[]) {
      const key = `${s.traceId}:${s.spanId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      spans.push(toSpan(s));
    }
  }
  spans.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  return { runId, mastraRunId: runId, traceId: primary ?? [...traceIds][0] ?? null, spans };
}
