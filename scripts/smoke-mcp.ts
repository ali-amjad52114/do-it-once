// REAL smoke for A2 (Skills over MCP). Starts `next dev` on :3022, connects with the MCP SDK client over
// Streamable HTTP + bearer, and drives: list tools → search_skills → get_skill → start_run → get_run
// until waiting_approval (must not complete by itself) → approve via the dashboard route → succeeded.
// Also: wrong token → 401, SKILL.md export downloads. Resets demo site + DB, stops the server, checks Kernel.
// Usage: npx tsx scripts/smoke-mcp.ts   (needs .env with ADDON_MCP=1 and MCP_TOKEN)
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import Kernel from '@onkernel/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 3022;
const BASE = `http://localhost:${PORT}`;
const TOKEN = process.env.MCP_TOKEN ?? '';
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
  log(`ok  ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startServer(): ChildProcess {
  const child = spawn('npx', ['next', 'dev', '--webpack', '-p', String(PORT)], {
    shell: true,
    env: { ...process.env, PUBLIC_APP_URL: BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => process.env.SMOKE_VERBOSE && process.stdout.write(d));
  child.stderr?.on('data', (d) => process.stderr.write(d));
  return child;
}

function stopServer(child: ChildProcess) {
  if (child.pid == null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

async function waitUp() {
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${BASE}/api/mcp`, { method: 'POST', signal: AbortSignal.timeout(60_000) });
      if (r.status === 401 || r.status === 404) return r.status;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error('next dev did not come up');
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (r.isError) throw new Error(`${name} failed: ${r.content[0]?.text}`);
  return JSON.parse(r.content[0].text) as T;
}

async function main() {
  check(TOKEN, 'MCP_TOKEN is set');
  check(process.env.ADDON_MCP === '1' || process.env.ADDON_MCP === 'true', 'ADDON_MCP is on');
  const server = startServer();
  let runId: string | null = null;
  try {
    const first = await waitUp();
    check(first === 401, 'no token → 401');
    const bad = await fetch(`${BASE}/api/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    check(bad.status === 401, 'wrong token → 401');

    const client = new Client({ name: 'smoke-mcp', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    check(
      JSON.stringify(names) === JSON.stringify(['get_run', 'get_skill', 'list_runs', 'search_skills', 'start_run']),
      `tools: ${names.join(', ')}`,
    );
    check(!names.some((n) => n.includes('approve')), 'no approve tool');
    check(tools.find((t) => t.name === 'start_run')?.description?.includes('dashboard'), 'start_run says approval is in the dashboard');

    const search = await call<{ matches: { skillId: string; title: string; score: number }[] }>(client, 'search_skills', {
      query: 'stop paying for Lumen+',
    });
    const top = search.matches[0];
    check(top && /cancel/i.test(top.title), `search → "${top?.title}" (${top?.score.toFixed(2)})`);

    const skill = await call<{ steps: { intent: string; requiresApproval: boolean }[]; version: number; triggers: string[] }>(
      client,
      'get_skill',
      { skillId: top.skillId },
    );
    check(skill.steps.length > 0 && skill.steps.some((s) => s.requiresApproval), `get_skill: ${skill.steps.length} steps, v${skill.version}, has an approval step`);

    const exp = await fetch(`${BASE}/api/skills-export/${top.skillId}`);
    const md = await exp.text();
    check(exp.status === 200 && /attachment; filename="SKILL.md"/.test(exp.headers.get('content-disposition') ?? ''), 'SKILL.md export is an attachment');
    check(md.startsWith('---\nname: ') && md.includes('description: ') && md.includes('start_run'), 'SKILL.md has frontmatter and MCP guidance');

    const started = await call<{ runId: string; dashboardUrl: string; triggerId: string | null }>(client, 'start_run', { skillId: top.skillId });
    runId = started.runId;
    check(runId && started.dashboardUrl === BASE, `start_run → ${runId} (trigger ${started.triggerId ?? 'none'})`);

    type RunSummary = { state: string; pendingApproval: { title: string } | null; result: { summary: string } | null; error: string | null };
    const poll = async (pred: (r: RunSummary) => boolean, ms: number) => {
      const end = Date.now() + ms;
      let last = '';
      for (;;) {
        const r = await call<RunSummary>(client, 'get_run', { runId });
        if (r.state !== last) log(`    state=${(last = r.state)}`);
        if (pred(r)) return r;
        if (['failed', 'stopped'].includes(r.state)) throw new Error(`run ended ${r.state}: ${r.error}`);
        if (Date.now() > end) throw new Error(`timeout in state ${r.state}`);
        await sleep(1500);
      }
    };
    const waiting = await poll((r) => r.state === 'waiting_approval' || r.state === 'succeeded', 180_000);
    check(waiting.state === 'waiting_approval', 'run paused for approval (did not complete by itself)');
    check(waiting.pendingApproval?.title, `pending approval: "${waiting.pendingApproval?.title}"`);
    await sleep(3000);
    const still = await call<RunSummary>(client, 'get_run', { runId });
    check(still.state === 'waiting_approval', 'still waiting after 3s');

    const ap = await fetch(`${BASE}/api/runs/${runId}/approve`, { method: 'POST' });
    check(ap.ok, `approved via dashboard route (${ap.status})`);
    const done = await poll((r) => r.state === 'succeeded', 180_000);
    check(done.result?.summary, `succeeded: ${done.result?.summary}`);

    const runs = await call<{ runs: { runId: string }[] }>(client, 'list_runs', { limit: 5 });
    check(runs.runs.some((r) => r.runId === runId), 'list_runs includes the run');
    await client.close();
  } finally {
    try {
      const reset = await fetch(`${BASE}/api/demo/reset`, { method: 'POST' });
      log(`reset: ${reset.status} ${await reset.text()}`);
    } catch (e) {
      log(`reset failed: ${e}`);
    }
    stopServer(server);
    await sleep(2000);
    if (process.env.KERNEL_API_KEY) {
      const kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY });
      const running: string[] = [];
      for await (const b of kernel.browsers.list()) running.push(b.session_id);
      log(`kernel browsers open: ${running.length}`);
      if (running.length > 1) log('WARNING: more than one Kernel browser open');
    }
  }
  log('SMOKE PASSED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
