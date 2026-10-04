// Shared JSON helpers for app/api route handlers. Server-only.
import { TERMINAL_STATES, type RunState } from '@/lib/contracts';

/** Next 16: dynamic route `params` is a Promise. */
export type IdContext = { params: Promise<{ id: string }> };

export function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Wraps a handler so unexpected throws become `{ error }` 500s instead of HTML error pages. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error('[api]', err);
      return jsonError(500, errorMessage(err));
    }
  };
}

/** Reads a JSON body. Empty body -> {}. Invalid JSON -> undefined. */
export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Parses an integer query param, clamped to [min, max]. */
export function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
