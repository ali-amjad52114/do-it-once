// CORS for Teach Mode: the extension posts from chrome-extension://<id>; local dev pages from localhost.
const ALLOWED = /^(chrome-extension:\/\/[a-p]{32}|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin');
  if (!origin || !ALLOWED.test(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

export function withCors(request: Request, res: Response): Response {
  for (const [k, v] of Object.entries(corsHeaders(request))) res.headers.set(k, v);
  return res;
}

export function preflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
