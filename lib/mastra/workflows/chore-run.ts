// The `choreRun` Mastra workflow (agent M1). Server-only.
//
//   prepare ──► dountil( chore-segment[ execute-steps ──► approval ] , status ≠ continue ) ──► verify ──► complete
//
// - prepare:       load the run + skill, state running, run.started, open the Kernel browser
// - execute-steps: perform browser steps until the end or an irreversible step needing approval
// - approval:      create the approval row, then `suspend({ approvalId, title, payload })`;
//                  resumed with `{ approved: boolean }` (approve → true, Stop → false)
// - verify:        screenshot proof + verification rules → succeeded / failed
// - complete:      report the final run state
// The loop lets a skill have several approval gates. Snapshots persist in Mastra storage (Neon
// PostgresStore in production), so `resume()` works from a fresh process. The step bodies live in
// lib/engine/engine.ts (`RunCore`); this file only wires them into Mastra.
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { SpanType, type TracingContext } from '@mastra/core/observability';
import { z } from 'zod';
import type { ActionOutcome, SkillStep } from '@/lib/contracts';
import type { ApprovalRequest, RunCore, StepTracer } from '@/lib/engine/engine';

export const flowStateSchema = z.object({
  runId: z.string(),
  sessionId: z.string().nullable(),
  lastUrl: z.string().nullable(),
  recovered: z.boolean(),
  /** continue → keep executing; awaiting_approval → gate; steps_done → verify; verified/halted → finished */
  status: z.enum(['continue', 'awaiting_approval', 'steps_done', 'verified', 'halted']),
  pendingStep: z.number().nullable(),
});
export type FlowState = z.infer<typeof flowStateSchema>;

export const approvalSuspendSchema = z.object({
  approvalId: z.string(),
  stepSequence: z.number(),
  title: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export const approvalResumeSchema = z.object({ approved: z.boolean() });

const runInputSchema = z.object({ runId: z.string() });
const runOutputSchema = z.object({ runId: z.string(), state: z.string(), success: z.boolean() });

/** Wraps a step body: Stop aborts become a halted flow; other errors fail the run (readable message) and the step. */
async function guarded(core: RunCore, state: FlowState, fn: () => Promise<FlowState>): Promise<FlowState> {
  try {
    return await fn();
  } catch (err) {
    if (core.isAbort(err)) return core.halted(state);
    await core.handleUnexpected(state.runId, err);
    throw err;
  }
}

/** Child span per browser step under the current workflow-step span. */
function spanTracer(tracing: TracingContext | undefined): StepTracer | undefined {
  const parent = tracing?.currentSpan;
  if (!parent) return undefined;
  return {
    start(step: SkillStep, kind) {
      const span = parent.createChildSpan({
        type: SpanType.GENERIC,
        name: `${kind === 'catch-up' ? 'catch-up' : 'browser step'} ${step.sequence}: ${step.intent}`,
        input: { action: step.actionType, target: step.targetDescription, locatorHint: step.locatorHint },
        metadata: { stepSequence: step.sequence, requiresApproval: step.requiresApproval },
      });
      return {
        end(outcome: ActionOutcome) {
          if (outcome.ok) {
            span.end({ output: { ok: true, url: outcome.page?.url, usedLocator: outcome.usedLocator } });
          } else {
            span.error({ error: new Error(outcome.error ?? 'step failed'), endSpan: true });
          }
        },
        fail(err: unknown) {
          span.error({ error: err instanceof Error ? err : new Error(String(err)), endSpan: true });
        },
      };
    },
  };
}

/** Builds the workflow bound to a run core (production: the process-wide core; tests: a fake-backed one). */
export function createChoreRunWorkflow(getCore: () => RunCore) {
  const prepare = createStep({
    id: 'prepare',
    description: 'Understand and prepare: load the skill and run, open the cloud browser',
    inputSchema: runInputSchema,
    outputSchema: flowStateSchema,
    execute: async ({ inputData }) => {
      const core = getCore();
      const blank: FlowState = { runId: inputData.runId, sessionId: null, lastUrl: null, recovered: false, status: 'continue', pendingStep: null };
      return guarded(core, blank, () => core.prepare(inputData.runId));
    },
  });

  const executeSteps = createStep({
    id: 'execute-steps',
    description: 'Replay the skill steps in the browser until done or an approval gate',
    inputSchema: flowStateSchema,
    outputSchema: flowStateSchema,
    execute: async ({ inputData, tracingContext }) => {
      const core = getCore();
      return guarded(core, inputData, () => core.executeSteps(inputData, spanTracer(tracingContext)));
    },
  });

  const approval = createStep({
    id: 'approval',
    description: 'Human approval before an irreversible step (suspend / resume)',
    inputSchema: flowStateSchema,
    outputSchema: flowStateSchema,
    suspendSchema: approvalSuspendSchema,
    resumeSchema: approvalResumeSchema,
    execute: async ({ inputData, resumeData, suspend }) => {
      if (inputData.status !== 'awaiting_approval') return inputData;
      const core = getCore();
      if (!resumeData) {
        const holder: { request: ApprovalRequest | null } = { request: null };
        const next = await guarded(core, inputData, async () => {
          const res = await core.requestApproval(inputData);
          holder.request = res.request;
          return res.state;
        });
        const r = holder.request;
        if (!r) return core.halted(next);
        return await suspend({ approvalId: r.approvalId, stepSequence: r.stepSequence, title: r.title, payload: r.payload });
      }
      // approve → { approved: true } (the engine already recorded approval.granted); Stop → { approved: false }.
      if (!resumeData.approved || core.isStopped(inputData.runId)) return core.halted(inputData);
      return { ...inputData, status: 'continue' as const, pendingStep: null };
    },
  });

  const segment = createWorkflow({
    id: 'chore-segment',
    description: 'Execute browser steps, then pass the approval gate if one was reached',
    inputSchema: flowStateSchema,
    outputSchema: flowStateSchema,
  })
    .then(executeSteps)
    .then(approval)
    .commit();

  const verify = createStep({
    id: 'verify',
    description: 'Verify on the website and save screenshot proof',
    inputSchema: flowStateSchema,
    outputSchema: flowStateSchema,
    execute: async ({ inputData }) => {
      const core = getCore();
      return guarded(core, inputData, () => core.verifyAndFinish(inputData));
    },
  });

  const complete = createStep({
    id: 'complete',
    description: 'Report the final run state',
    inputSchema: flowStateSchema,
    outputSchema: runOutputSchema,
    execute: async ({ inputData }) => {
      const core = getCore();
      core.forget(inputData.runId);
      const run = await core.repo.getRun(inputData.runId);
      return { runId: inputData.runId, state: run?.state ?? 'unknown', success: run?.state === 'succeeded' };
    },
  });

  return createWorkflow({
    id: 'choreRun',
    description: 'Replay a learned chore in a Kernel cloud browser with a human approval gate',
    inputSchema: runInputSchema,
    outputSchema: runOutputSchema,
  })
    .then(prepare)
    .dountil(segment, async ({ inputData }) => inputData.status !== 'continue')
    .then(verify)
    .then(complete)
    .commit();
}

export type ChoreRunWorkflow = ReturnType<typeof createChoreRunWorkflow>;
