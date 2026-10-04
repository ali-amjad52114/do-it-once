// Exa research for self-heal: ONE /search call with highlights, used at most once per heal and only
// when the stored path is clearly stale. Never blocks: 5 s timeout, errors become "no public docs found".
import Exa from 'exa-js';

export interface ResearchSource {
  url: string;
  title: string | null;
  highlights: string[];
}

export interface ProcedureResearch {
  query: string;
  sources: ResearchSource[];
  summary: string; // "no public docs found" or "3 public pages"
  costDollars: number | null;
  ms: number;
}

export async function researchProcedure(
  task: string,
  opts: { site?: string | null; failedStep?: string | null; timeoutMs?: number } = {},
): Promise<ProcedureResearch> {
  const t0 = Date.now();
  const query = `${task}${opts.failedStep ? ` (the "${opts.failedStep}" option was moved or renamed)` : ''}: current step-by-step instructions`;
  const empty = (summary: string): ProcedureResearch => ({ query, sources: [], summary, costDollars: null, ms: Date.now() - t0 });
  if (!process.env.EXA_API_KEY) return empty('no public docs found (Exa not configured)');
  try {
    const exa = new Exa(process.env.EXA_API_KEY);
    const call = exa.search(query, {
      type: 'auto',
      numResults: 5,
      ...(opts.site ? { includeDomains: [opts.site] } : {}),
      contents: { highlights: true },
    });
    const timeout = new Promise<null>((res) => setTimeout(() => res(null), opts.timeoutMs ?? 5000));
    const res = await Promise.race([call, timeout]);
    call.catch(() => undefined);
    if (!res) return empty('no public docs found (Exa timed out)');
    const sources: ResearchSource[] = res.results.map((r) => ({
      url: r.url,
      title: r.title ?? null,
      highlights: ((r as { highlights?: string[] }).highlights ?? []).slice(0, 3).map((h) => h.slice(0, 300)),
    }));
    const cost = (res as { costDollars?: { total?: number } }).costDollars?.total ?? null;
    return {
      query,
      sources,
      summary: sources.length ? `${sources.length} public page${sources.length > 1 ? 's' : ''}` : 'no public docs found',
      costDollars: cost,
      ms: Date.now() - t0,
    };
  } catch (err) {
    return empty(`no public docs found (${err instanceof Error ? err.message.slice(0, 80) : 'error'})`);
  }
}
