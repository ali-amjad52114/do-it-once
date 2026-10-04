import Link from 'next/link';
import { Wordmark } from '@/components/Brand';
import { Card, SectionLabel } from '@/components/ui';
import { CopyBlock } from './CopyBlock';

export const metadata = { title: 'Connect Claude · Do It Once' };
export const dynamic = 'force-dynamic';

const TOOLS: { name: string; desc: string }[] = [
  { name: 'search_skills', desc: 'Find your saved chores from a request like "stop paying for Lumen+".' },
  { name: 'get_skill', desc: 'Read a skill: steps, which step is irreversible, preferences, version, triggers.' },
  { name: 'list_runs', desc: 'Recent runs with state and result.' },
  { name: 'start_run', desc: 'Replay a skill in a cloud browser. Returns a run id and this dashboard URL.' },
  { name: 'get_run', desc: 'Run state, the pending approval title, and the verified result.' },
];

export default function ConnectPage() {
  const base = (process.env.PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const url = `${base}/api/mcp`;
  const claudeCode = `claude mcp add --transport http do-it-once ${url} --header "Authorization: Bearer <MCP_TOKEN>"`;
  const claudeDesktop = JSON.stringify(
    {
      mcpServers: {
        'do-it-once': {
          command: 'npx',
          args: ['-y', 'mcp-remote', url, '--header', 'Authorization: Bearer ${MCP_TOKEN}'],
          env: { MCP_TOKEN: '<MCP_TOKEN>' },
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-24 sm:px-8">
      <header className="flex items-center justify-between py-6 sm:py-8">
        <Wordmark />
        <Link
          href="/"
          className="inline-flex h-8 items-center rounded-full px-3 text-[13px] text-ink-faint transition-colors hover:bg-ink/5 hover:text-ink-soft"
        >
          Back to dashboard
        </Link>
      </header>

      <section className="animate-fade-up pt-6 pb-10">
        <h1 className="font-display text-4xl tracking-tight text-ink sm:text-5xl">Connect Claude</h1>
        <p className="mt-3 max-w-xl text-[16px] leading-relaxed text-ink-soft">
          Let Claude find and start the chores you taught once. Claude can start a run, but{' '}
          <span className="font-medium text-approve-ink">you approve every irreversible step here</span>, in the
          dashboard. There is no approve tool.
        </p>
      </section>

      <div className="space-y-8">
        <Card className="p-6 sm:p-8">
          <SectionLabel>MCP server</SectionLabel>
          <CopyBlock label="Streamable HTTP URL" text={url} />
          <p className="mt-4 text-[14px] leading-relaxed text-ink-soft">
            Every request needs <code className="rounded bg-paper-deep px-1.5 py-0.5 text-[13px]">Authorization: Bearer &lt;token&gt;</code>.
            The token is the server&apos;s <code className="rounded bg-paper-deep px-1.5 py-0.5 text-[13px]">MCP_TOKEN</code> environment
            variable: ask the owner of this app for it.
          </p>
        </Card>

        <Card className="p-6 sm:p-8">
          <SectionLabel>Claude Code</SectionLabel>
          <CopyBlock label="Terminal" text={claudeCode} />
        </Card>

        <Card className="p-6 sm:p-8">
          <SectionLabel>Claude Desktop</SectionLabel>
          <p className="mb-4 text-[14px] leading-relaxed text-ink-soft">
            Add a custom connector with the URL above (Settings → Connectors), or add this to{' '}
            <code className="rounded bg-paper-deep px-1.5 py-0.5 text-[13px]">claude_desktop_config.json</code>:
          </p>
          <CopyBlock label="claude_desktop_config.json" text={claudeDesktop} />
        </Card>

        <Card className="p-6 sm:p-8">
          <SectionLabel>Tools</SectionLabel>
          <ul className="divide-y divide-line">
            {TOOLS.map((t) => (
              <li key={t.name} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:gap-4">
                <code className="shrink-0 text-[14px] font-medium text-ink sm:w-36">{t.name}</code>
                <span className="text-[14px] text-ink-soft">{t.desc}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[13px] text-ink-faint">
            Prefer a file? Open any skill and use “Download as Claude Skill” to get a SKILL.md.
          </p>
        </Card>
      </div>
    </div>
  );
}
