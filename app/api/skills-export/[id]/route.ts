// A2: download a skill as a Claude Skill (SKILL.md, plain text attachment).
import { getSkill } from '@/lib/neon/repo';
import { skillToMarkdown } from '@/lib/mcp/skillmd';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const skill = await getSkill(id).catch(() => null);
  if (!skill) return Response.json({ error: `Skill ${id} not found` }, { status: 404 });
  return new Response(skillToMarkdown(skill), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="SKILL.md"`,
      'Cache-Control': 'no-store',
    },
  });
}
