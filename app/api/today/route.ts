import { DEMO_USER_ID, type TodayItem } from '@/lib/contracts';
import { listTodayItems } from '@/lib/neon/repo';
import { handle } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle(async () => {
  const items: TodayItem[] = await listTodayItems(DEMO_USER_ID);
  return Response.json({ items });
});
