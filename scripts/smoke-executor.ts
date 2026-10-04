// Smoke test for the Executor tool adapter.
//   npx tsx scripts/smoke-executor.ts
// If EXECUTOR_MCP_URL + EXECUTOR_API_KEY are set, this makes a REAL call: it lists Executor's tools,
// then creates the event on the Google Calendar the user connected in Executor. Otherwise it uses the
// .ics fallback. Either way the .ics is written to the OS temp dir.
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIcs, getToolAdapter, listExecutorTools, readExecutorConfig } from '@/lib/executor';

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
  console.log(`Executor configured: ${cfg ? `yes (${new URL(cfg.url).origin}${new URL(cfg.url).pathname})` : 'no (EXECUTOR_MCP_URL / EXECUTOR_API_KEY unset)'}`);
  if (cfg) {
    try {
      const tools = await listExecutorTools();
      console.log('MCP tools:', tools.mcpTools.join(', ') || '(none)');
      console.log('Integrations:', JSON.stringify(tools.integrations, null, 2).slice(0, 2000));
      console.log('Calendar tools:', tools.calendarTools.map((t) => t.id).join(', ') || '(none — connect Google Calendar)');
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
