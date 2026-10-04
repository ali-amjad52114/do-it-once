// A2: "Do It Once" as an MCP server. Claude can search, read and start the user's skills and watch
// runs. There is deliberately NO approve tool: irreversible steps are approved by the user in the
// dashboard. Server-only. Built per request (stateless Streamable HTTP).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { DEMO_USER_ID } from '@/lib/contracts';
import { getRunEngine } from '@/lib/engine';
import { getLatestApproval, getRun, getSkill, listRuns, listSkills, listTodayItems } from '@/lib/neon/repo';
import { matchSkills } from '@/lib/skills/retrieve';
import { publicAppUrl } from './auth';

const APPROVAL_NOTE =
  'Runs pause before any irreversible step (cancel, pay, submit); the user approves or denies it in the Do It Once dashboard. You cannot approve on their behalf.';

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

// ── Tool implementations (exported for tests / reuse)

export async function searchSkills(query: string) {
  const matches = await matchSkills(DEMO_USER_ID, query, 3);
  if (matches.length) return { matches };
  // Nothing matched: give the agent the catalogue so it can still pick (or tell the user there is none).
  const all = await listSkills(DEMO_USER_ID);
  return { matches: [], availableSkills: all.map((s) => ({ skillId: s.id, title: s.title, description: s.description })) };
}

export async function getSkillSummary(skillId: string) {
  const skill = await getSkill(skillId);
  if (!skill) return null;
  return {
    skillId: skill.id,
    title: skill.title,
    description: skill.description,
    version: skill.version,
    status: skill.status,
    startUrl: skill.startUrl,
    triggers: skill.triggers,
    preferences: skill.preferences,
    steps: skill.steps.map((s) => ({ sequence: s.sequence, intent: s.intent, requiresApproval: s.requiresApproval })),
    runCount: skill.runCount,
    successCount: skill.successCount,
    exportUrl: `${publicAppUrl()}/api/skills-export/${skill.id}`,
  };
}

export async function startRunForSkill(skillId: string) {
  const skill = await getSkill(skillId);
  if (!skill) return null;
  // Attach the pending Today item for this skill (e.g. the Lumen+ renewal email), like the dashboard does.
  const today = await listTodayItems(DEMO_USER_ID).catch(() => []);
  const trigger = today.find((t) => t.state === 'pending' && t.matchedSkill?.id === skillId) ?? null;
  const { runId } = await getRunEngine().startRun({ skillId, userId: DEMO_USER_ID, triggerId: trigger?.triggerId ?? null });
  return { runId, skillTitle: skill.title, triggerId: trigger?.triggerId ?? null, dashboardUrl: publicAppUrl(), note: APPROVAL_NOTE };
}

export async function getRunSummary(runId: string) {
  const run = await getRun(runId);
  if (!run) return null;
  const approval = run.state === 'waiting_approval' ? await getLatestApproval(runId) : null;
  return {
    runId: run.id,
    skillId: run.skillId,
    state: run.state,
    currentStep: run.currentStep,
    pendingApproval:
      approval && approval.status === 'pending'
        ? { title: approval.title, description: approval.description, approveIn: publicAppUrl() }
        : null,
    result: run.result ? { success: run.result.success, summary: run.result.summary, finalUrl: run.result.finalUrl } : null,
    error: run.error,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    dashboardUrl: publicAppUrl(),
  };
}

export async function listRecentRuns(limit: number) {
  const runs = await listRuns(DEMO_USER_ID, { limit });
  return {
    runs: runs.map((r) => ({
      runId: r.id,
      skillId: r.skillId,
      state: r.state,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      summary: r.result?.summary ?? r.error ?? null,
    })),
  };
}

// ── Server

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'do-it-once', version: '1.0.0' },
    {
      instructions:
        "Do It Once replays the user's personal web chores (skills) in a cloud browser. Use search_skills to find a skill for the user's request, get_skill to inspect it, start_run to run it, then poll get_run. " +
        APPROVAL_NOTE,
    },
  );

  server.registerTool(
    'search_skills',
    {
      title: 'Search skills',
      description: "Find the user's saved chores (skills) that match a natural-language request, e.g. \"stop paying for Lumen+\". Returns skill ids with a match score.",
      inputSchema: { query: z.string().min(1).describe("The user's request in their own words") },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => ok(await searchSkills(query)),
  );

  server.registerTool(
    'get_skill',
    {
      title: 'Get skill',
      description: `Read one skill: its steps (intent, and whether the step is irreversible and needs approval), preferences, version and trigger phrases. ${APPROVAL_NOTE}`,
      inputSchema: { skillId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ skillId }) => {
      const s = await getSkillSummary(skillId);
      return s ? ok(s) : fail(`Skill ${skillId} not found`);
    },
  );

  server.registerTool(
    'list_runs',
    {
      title: 'List runs',
      description: 'Recent runs of any skill, newest first, with state and result summary.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe('Default 10') },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => ok(await listRecentRuns(limit ?? 10)),
  );

  server.registerTool(
    'start_run',
    {
      title: 'Start run',
      description: `Start replaying a skill in a cloud browser. Returns a runId and the dashboard URL. ${APPROVAL_NOTE} Tell the user to open the dashboard to approve, then poll get_run.`,
      inputSchema: { skillId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ skillId }) => {
      try {
        const r = await startRunForSkill(skillId);
        return r ? ok(r) : fail(`Skill ${skillId} not found`);
      } catch (err) {
        return fail(`Could not start the run: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    'get_run',
    {
      title: 'Get run',
      description: `Status of a run: state (queued, running, waiting_approval, verifying, succeeded, failed, stopped), the pending approval title if any, and the verified result summary. When state is waiting_approval, ask the user to approve in the dashboard; do not try to approve it yourself.`,
      inputSchema: { runId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) => {
      const r = await getRunSummary(runId);
      return r ? ok(r) : fail(`Run ${runId} not found`);
    },
  );

  return server;
}

/** Handles one Streamable HTTP request in stateless JSON mode (fresh server + transport per request). */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // JSON mode: the response is fully built once handleRequest resolves.
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  }
}
