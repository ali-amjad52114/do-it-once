// Which add-ons are switched on (server env flags), so client components can show their entry points.
import { flag } from '@/lib/addons/flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
    judge: flag('ADDON_JUDGE'),
    mcp: flag('ADDON_MCP'),
    guide: flag('ADDON_GUIDE'),
    discover: flag('ADDON_DISCOVER'),
  });
}
