// Smoke test for the Executor tool adapter.
//   npx tsx scripts/smoke-executor.ts           auto: Cloud HTTP if EXECUTOR_MCP_URL+KEY, else local CLI (stdio), else .ics
//   npx tsx scripts/smoke-executor.ts --local   force the local `executor mcp --mode passthrough` (stdio) path
//   npx tsx scripts/smoke-executor.ts --ics     force the .ics fallback (EXECUTOR_LOCAL=0, no HTTP)
// With Executor configured this makes a REAL call: it lists Executor's tools/integrations, then creates the
// event only on a Google Calendar the user connected in Executor. Either way the .ics is written to the OS temp dir.
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIcs, closeExecutor, describeConfig, getToolAdapter, listExecutorTools, readExecutorConfig } from '@/lib/executor';

const args = process.argv.slice(2);
if (args.includes('--local') || args.includes('--ics')) {
  delete process.env.EXECUTOR_MCP_URL;
  delete process.env.EXECUTOR_API_KEY;
  delete process.env.EXECUTOR_AUTH_TOKEN;
}
if (args.includes('--ics')) process.env.EXECUTOR_LOCAL = '0';

async function main() {
  // Tomorrow 10:00–10:30 local time.
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60_000);
  const input = {
    title: 'Do It Once demo · Return drop-off at UPS Store',
    start: start.toISOString(),
    end: end.toISOString(),
    location: 'The UPS Store',
    description: 'Created by Do It Once after the return chore.',
  };

  const cfg = readExecutorConfig();
  console.log(`Executor transport: ${cfg ? describeConfig(cfg) : 'none (no EXECUTOR_MCP_URL+KEY, no local CLI) → .ics'}`);
  if (cfg) {
    const t0 = Date.now();
    try {
      const r = await listExecutorTools();
      console.log(`connected + listed in ${Date.now() - t0}ms`);
      console.log('MCP tools:', r.mcpTools.join(', ') || '(none)');
      console.log('integrations:', JSON.stringify(r.integrations).slice(0, 1500));
      console.log(`search "${r.searchQuery}":`, JSON.stringify(r.searchResult).slice(0, 1500));
      console.log('calendar tools:', r.calendarTools.map((t) => t.id).join(', ') || '(none — connect Google Calendar in Executor)');
    } catch (e) {
      console.log('listExecutorTools failed:', e instanceof Error ? e.message : e);
    }
  }

  console.log(`Creating "${input.title}" ${start.toString()} → ${end.toTimeString()}`);
  const result = await getToolAdapter().createCalendarEvent(input);
  console.log(`PATH: ${result.via}  ok=${result.ok}`);
  console.log(`detail: ${result.detail}`);
  if (result.url) console.log(`url: ${result.url}`);

  const ics = result.icsContent ?? buildIcs(input);
  const file = join(tmpdir(), 'do-it-once-return-dropoff.ics');
  writeFileSync(file, ics);
  console.log(`.ics written: ${file} (${ics.length} bytes)`);
  console.log(ics);
  if (!result.ok) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeExecutor());
