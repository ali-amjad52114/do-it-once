import { DEMO_USER_ID, type SkillSummary } from '@/lib/contracts';
import { listSkills } from '@/lib/neon/repo';
import { handle } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle(async () => {
  const skills: SkillSummary[] = (await listSkills(DEMO_USER_ID)).map((s) => ({
    ...s,
    successRate: s.runCount > 0 ? s.successCount / s.runCount : 0,
  }));
  return Response.json({ skills });
});
