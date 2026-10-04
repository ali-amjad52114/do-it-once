// Live smoke test for the Kernel browser adapter (costs a few cents of Kernel time).
//   npx tsx scripts/smoke-kernel.ts [url]                 example.com read + click + screenshot
//   npx tsx scripts/smoke-kernel.ts --cancel [--confirm]  seeded Cancel-subscription steps on DEMO_SITE_URL
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionOutcome, ElementTarget } from '@/lib/contracts';
import { getKernelAdapter } from '@/lib/kernel';

const args = process.argv.slice(2);
const cancelMode = args.includes('--cancel');
const confirm = args.includes('--confirm');
const url = args.find((a) => !a.startsWith('--')) ?? 'https://example.com';

const adapter = getKernelAdapter();

function show(label: string, o: ActionOutcome) {
  console.log(`${o.ok ? 'OK  ' : 'FAIL'} ${label}  usedLocator=${o.usedLocator ?? '-'}  url=${o.page.url}${o.error ? `  error=${o.error}` : ''}`);
  if (!o.ok) throw new Error(`${label} failed: ${o.error}`);
}

async function exampleFlow(sessionId: string) {
  const page = await adapter.readPage(sessionId);
  console.log(`page: "${page.title}" ${page.url}\n  text: ${page.text.slice(0, 160)}…`);
  if (!`${page.title} ${page.text}`.includes('Example Domain')) throw new Error('example.com content not found');

  let o = await adapter.click(sessionId, { description: 'Learn more link', matchText: 'Learn more' });
  if (!o.ok) o = await adapter.click(sessionId, { description: 'More information link', matchText: 'More information' });
  show('click "Learn more"/"More information"', o);

  const shot = await adapter.screenshot(sessionId);
  const file = join(tmpdir(), `kernel-smoke-${Date.now()}.png`);
  writeFileSync(file, shot);
  const isPng = shot.subarray(0, 4).toString('hex') === '89504e47';
  console.log(`screenshot: ${shot.length} bytes, png=${isPng} → ${file}`);
  if (!isPng) throw new Error('screenshot is not a PNG');
}

interface SmokeStep {
  intent: string;
  action: 'navigate' | 'click';
  path?: string;
  target?: ElementTarget;
  expectedAfter: string;
  approval?: boolean;
}

// docs/CONTRACTS.md "The seeded skill"
const CANCEL_STEPS: SmokeStep[] = [
  { intent: 'Open my Lumen+ account', action: 'navigate', path: '/account', expectedAfter: 'Welcome back' },
  {
    intent: 'Open billing settings', action: 'click', expectedAfter: 'Manage membership',
    target: { description: 'Billing link in the account sidebar', matchText: 'Billing', locatorHint: 'role=link[name="Billing"]' },
  },
  {
    intent: 'Open membership management', action: 'click', expectedAfter: 'Cancel membership',
    target: { description: 'Manage membership button', matchText: 'Manage membership', locatorHint: 'role=link[name="Manage membership"]' },
  },
  {
    intent: 'Start cancellation', action: 'click', expectedAfter: 'Before you go',
    target: { description: 'Cancel membership link', matchText: 'Cancel membership', locatorHint: 'role=link[name="Cancel membership"]' },
  },
  {
    intent: 'Decline the retention offer', action: 'click', expectedAfter: 'Confirm cancellation',
    target: {
      description: 'No thanks, continue to cancel button',
      matchText: 'No thanks, continue to cancel',
      locatorHint: 'role=link[name="No thanks, continue to cancel"]',
    },
  },
  {
    intent: 'Confirm the cancellation', action: 'click', expectedAfter: 'Membership canceled', approval: true,
    target: { description: 'Confirm cancellation button', matchText: 'Confirm cancellation', locatorHint: 'role=button[name="Confirm cancellation"]' },
  },
];

async function cancelFlow(sessionId: string, base: string) {
  for (const [i, s] of CANCEL_STEPS.entries()) {
    const label = `${i + 1}. ${s.intent}`;
    if (s.approval && !confirm) {
      console.log(`SKIP ${label} (requires approval; pass --confirm to click it)`);
      break;
    }
    const o = s.action === 'navigate' ? await adapter.goto(sessionId, new URL(s.path!, base).toString()) : await adapter.click(sessionId, s.target!);
    show(label, o);
    show(`   wait "${s.expectedAfter}"`, await adapter.waitForText(sessionId, s.expectedAfter));
  }
}

async function main() {
  const base = process.env.DEMO_SITE_URL;
  if (cancelMode && !base) throw new Error('--cancel needs DEMO_SITE_URL');

  const t0 = Date.now();
  const session = await adapter.open(cancelMode ? {} : { startUrl: url });
  console.log(`opened ${session.id} in ${Date.now() - t0} ms`);
  console.log(`live view: ${session.liveViewUrl ?? '(none returned)'}`);
  try {
    if (cancelMode) await cancelFlow(session.id, base!);
    else await exampleFlow(session.id);
  } finally {
    await adapter.close(session.id);
    await adapter.close(session.id); // idempotent
    console.log(`closed ${session.id}; cache entries left: ${adapter.connections.size}`);
  }
  if (adapter.connections.size !== 0) throw new Error('connection cache not clean after close');
  console.log('SMOKE PASS');
}

main().catch(async (err) => {
  console.error('SMOKE FAIL:', err instanceof Error ? err.message : err);
  await adapter.closeAll();
  process.exitCode = 1;
});
