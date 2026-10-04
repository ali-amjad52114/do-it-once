import { getArtifact } from '@/lib/neon/repo';
import { handle, jsonError, type IdContext } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle(async (_request: Request, ctx: IdContext) => {
  const { id } = await ctx.params;
  const artifact = await getArtifact(id);
  if (!artifact) return jsonError(404, `Artifact ${id} not found`);

  if (artifact.bytes) {
    return new Response(new Uint8Array(artifact.bytes), {
      headers: {
        'Content-Type': artifact.mimeType || 'application/octet-stream',
        'Content-Length': String(artifact.bytes.length),
        // Artifacts are immutable once written.
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  }
  if (/^https?:\/\//i.test(artifact.location)) return Response.redirect(artifact.location, 302);
  return jsonError(404, `Artifact ${id} has no stored bytes (location: ${artifact.location})`);
});
