// CONTRACT STUB — owned by agent F2 (Schema). F2 replaces the bodies; signatures are fixed.
// All functions are server-only. Rows are mapped snake_case -> camelCase types from lib/contracts.
import type {
  Approval,
  ApprovalStatus,
  Artifact,
  ArtifactType,
  EventType,
  ExecutionEvent,
  IncomingTrigger,
  RunResult,
  RunState,
  Skill,
  SkillDetail,
  SkillRun,
  SkillStep,
  TodayItem,
  TriggerState,
} from '@/lib/contracts';

const todo = (name: string): never => {
  throw new Error(`lib/neon/repo.${name} not implemented yet`);
};

// ── Skills
export async function listSkills(userId: string): Promise<Skill[]> { return todo('listSkills'); }
export async function getSkill(skillId: string): Promise<SkillDetail | null> { return todo('getSkill'); }
/** Updates locatorHint (and nothing else) after a step succeeded with a new selector. */
export async function updateStepLocator(stepId: string, locatorHint: string): Promise<void> { return todo('updateStepLocator'); }
/** run_count += 1, success_count += success ? 1 : 0, last_success_at, confidence = success_count / run_count. */
export async function recordSkillOutcome(skillId: string, success: boolean): Promise<void> { return todo('recordSkillOutcome'); }

// ── Runs
export async function createRun(input: { skillId: string; userId: string; triggerId?: string | null }): Promise<SkillRun> { return todo('createRun'); }
export async function getRun(runId: string): Promise<SkillRun | null> { return todo('getRun'); }
export async function listRuns(userId: string, opts?: { skillId?: string; triggerId?: string; limit?: number }): Promise<SkillRun[]> { return todo('listRuns'); }
export async function updateRun(
  runId: string,
  patch: Partial<Pick<SkillRun, 'state' | 'currentStep' | 'browserSessionId' | 'liveViewUrl' | 'error' | 'completedAt'>> & { result?: RunResult | null },
): Promise<SkillRun> { return todo('updateRun'); }

// ── Events (sequence assigned atomically per run)
export async function appendEvent(runId: string, type: EventType, message: string, metadata?: Record<string, unknown>): Promise<ExecutionEvent> { return todo('appendEvent'); }
export async function listEvents(runId: string, afterSequence?: number): Promise<ExecutionEvent[]> { return todo('listEvents'); }

// ── Approvals
export async function createApproval(input: Omit<Approval, 'id' | 'status' | 'createdAt' | 'decidedAt'>): Promise<Approval> { return todo('createApproval'); }
export async function getLatestApproval(runId: string): Promise<Approval | null> { return todo('getLatestApproval'); }
export async function decideApproval(approvalId: string, status: Exclude<ApprovalStatus, 'pending'>): Promise<Approval> { return todo('decideApproval'); }

// ── Artifacts (bytes stored base64 in artifacts.content_base64 when location is "neon:<id>")
export async function createArtifact(input: { runId: string; type: ArtifactType; mimeType: string; bytes?: Buffer; location?: string; metadata?: Record<string, unknown> }): Promise<Artifact> { return todo('createArtifact'); }
export async function getArtifact(artifactId: string): Promise<(Artifact & { bytes: Buffer | null }) | null> { return todo('getArtifact'); }
export async function listArtifacts(runId: string): Promise<Artifact[]> { return todo('listArtifacts'); }

// ── Triggers / Today
export async function listTodayItems(userId: string): Promise<TodayItem[]> { return todo('listTodayItems'); }
export async function getTrigger(triggerId: string): Promise<IncomingTrigger | null> { return todo('getTrigger'); }
export async function setTriggerState(triggerId: string, state: TriggerState): Promise<void> { return todo('setTriggerState'); }

// Silence unused-type lint in the stub.
export type _Unused = SkillStep | RunState;
