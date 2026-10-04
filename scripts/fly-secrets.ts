// Stage the app's server secrets on Fly from a local .env file.
// Usage: npx tsx scripts/fly-secrets.ts [path/to/.env] [--deploy]
//   (Node 24 also runs it directly: node scripts/fly-secrets.ts)
// Values go to `flyctl secrets import` over stdin; they are never printed or put on argv.
// --stage means they apply on the next `flyctl deploy` (or pass --deploy to run `flyctl secrets deploy`).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP = process.env.FLY_APP ?? 'neon-agent-ali';
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL ?? `https://${APP}.fly.dev`;
const FLYCTL = process.env.FLYCTL ?? 'flyctl';

const args = process.argv.slice(2);
const deploy = args.includes('--deploy');
const envPath = resolve(args.find((a) => !a.startsWith('--')) ?? '.env');
if (!existsSync(envPath)) {
  console.error(`No env file at ${envPath}`);
  process.exit(1);
}

// Keys the server reads at runtime. Exact names or prefixes ending in '_'.
const WANTED = [
  'DATABASE_URL',
  'NEON_',
  'MASTRA_',
  'KERNEL_API_KEY',
  'DEMO_SITE_URL',
  'DEMO_RESET_TOKEN',
  'EXA_API_KEY',
  'AGENTMAIL_',
  'ASSISTANT_API_KEY',
  'SPRITES_',
  'SPRITE_',
  'EXECUTOR_',
];
const wanted = (k: string) => WANTED.some((w) => (w.endsWith('_') ? k.startsWith(w) : k === w));

function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    const q = v[0];
    if ((q === '"' || q === "'") && v.endsWith(q) && v.length >= 2) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    if (v !== '') out.set(m[1], v);
  }
  return out;
}

const all = parseEnv(readFileSync(envPath, 'utf8'));
const secrets = new Map([...all].filter(([k]) => wanted(k)));
secrets.set('PUBLIC_APP_URL', PUBLIC_APP_URL);

for (const [k, v] of secrets) {
  if (/[\r\n]/.test(v)) {
    console.error(`${k} contains a newline; not supported by this script`);
    process.exit(1);
  }
}

const body = [...secrets].map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
const res = spawnSync(FLYCTL, ['secrets', 'import', '--stage', '--app', APP], {
  input: body,
  stdio: ['pipe', 'inherit', 'inherit'],
});
if (res.error || res.status !== 0) {
  console.error(`flyctl secrets import failed (${res.error?.message ?? `exit ${res.status}`})`);
  process.exit(1);
}
console.log(`Staged ${secrets.size} secrets on ${APP}: ${[...secrets.keys()].sort().join(', ')}`);

if (deploy) {
  const d = spawnSync(FLYCTL, ['secrets', 'deploy', '--app', APP], { stdio: 'inherit' });
  process.exit(d.status ?? 1);
}
