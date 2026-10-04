// Unit tests (mocked gateway + SQL) always run. The Neon integration suite runs only with
// RUN_DB_TESTS=1 against your branch's DATABASE_URL (needs migration 002 + seed); it temporarily
// activates "Return online order" with a few triggers and restores it to draft afterwards.
import 'dotenv/config';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const real = vi.hoisted(() => ({
  embed: null as null | ((texts: string[], model?: string) => Promise<number[][]>),
  getSql: null as null | (() => unknown),
}));

vi.mock('@/lib/ai/gateway', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/ai/gateway')>();
  real.embed = mod.embed;
  return { ...mod, embed: vi.fn(mod.embed) };
});
vi.mock('@/lib/neon/db', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/neon/db')>();
  real.getSql = mod.getSql;
  return { ...mod, getSql: vi.fn(mod.getSql) };
});

import { embed } from '@/lib/ai/gateway';
import { getSql } from '@/lib/neon/db';
import {
  KEYWORD_THRESHOLD,
  RELATIVE_MARGIN,
  SEMANTIC_THRESHOLD,
  embedSkillTriggers,
  keywordMatches,
  keywordScore,
  matchSkills,
  rankMatches,
  type Candidate,
} from './retrieve';

const USER = '00000000-0000-0000-0000-000000000001';
const CANCEL = 'c';
const RETURN = 'r';

type Rows = Record<string, unknown>[];
/** Fake tagged-template sql: routes by query text. */
function fakeSql(handlers: { semantic?: () => Rows; keyword?: () => Rows }) {
  const calls: string[] = [];
  const sql = (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    calls.push(text);
    if (text.includes('skill_profile_embeddings')) return Promise.resolve(handlers.semantic?.() ?? []);
    return Promise.resolve(handlers.keyword?.() ?? []);
  };
  return Object.assign(sql, { calls, transaction: vi.fn(async () => []) });
}

const kwRows: Rows = [
  { skill_id: CANCEL, title: 'Cancel subscription', phrase: 'cancel subscription' },
  { skill_id: CANCEL, title: 'Cancel subscription', phrase: 'stop paying for this' },
  { skill_id: RETURN, title: 'Return online order', phrase: 'return my order' },
];

describe('keyword fallback', () => {
  it('scores the fraction of phrase words present in the query', () => {
    expect(keywordScore('please stop paying for this now', 'stop paying for this')).toBe(1);
    expect(keywordScore('cancel it', 'cancel subscription')).toBe(0.5);
    expect(keywordScore('book a haircut', 'cancel subscription')).toBe(0);
    expect(keywordScore('anything', '')).toBe(0);
  });

  it('keeps the best phrase per skill and applies the keyword threshold', () => {
    const rows = kwRows.map((r) => ({ skillId: r.skill_id as string, title: r.title as string, phrase: r.phrase as string }));
    const m = keywordMatches('I want to stop paying for this', rows, 3);
    expect(m).toEqual([{ skillId: CANCEL, title: 'Cancel subscription', score: 1, matchedPhrase: 'stop paying for this' }]);
    // "my" alone (1/3 of "return my order") is below KEYWORD_THRESHOLD
    expect(KEYWORD_THRESHOLD).toBeGreaterThan(1 / 3);
    expect(keywordMatches('book my haircut', rows, 3)).toEqual([]);
  });
});

describe('threshold logic', () => {
  const c = (skillId: string, score: number | null, phrase: string | null = 'p'): Candidate => ({
    skillId, title: skillId, phrase, score,
  });

  it('drops scores below the threshold and null (unembedded) candidates', () => {
    expect(rankMatches([c('a', 0.59), c('b', null), c('c', 0.6)], 0.6, 3).map((m) => m.skillId)).toEqual(['c']);
  });

  it('keeps the best phrase per skill, sorted descending, truncated to limit', () => {
    const m = rankMatches([c('a', 0.7, 'x'), c('a', 0.9, 'y'), c('b', 0.8), c('d', 0.65)], 0.6, 2);
    expect(m.map((x) => [x.skillId, x.score, x.matchedPhrase])).toEqual([['a', 0.9, 'y'], ['b', 0.8, 'p']]);
  });

  it('drops matches more than the relative margin below the top one', () => {
    const m = rankMatches([c('a', 1), c('b', 0.61)], 0.6, 3, RELATIVE_MARGIN);
    expect(m.map((x) => x.skillId)).toEqual(['a']);
    expect(rankMatches([c('a', 0.75), c('b', 0.7)], 0.6, 3, RELATIVE_MARGIN)).toHaveLength(2);
  });
});

describe('matchSkills (mocked embed + sql)', () => {
  afterEach(() => {
    vi.mocked(embed).mockImplementation(real.embed!);
    vi.mocked(getSql).mockImplementation(real.getSql! as typeof getSql);
  });

  it('returns semantic matches above the threshold', async () => {
    vi.mocked(embed).mockResolvedValue([[0.1, 0.2]]);
    const sql = fakeSql({
      semantic: () => [
        { skill_id: CANCEL, title: 'Cancel subscription', phrase: 'stop paying for this', score: '0.93' },
        { skill_id: RETURN, title: 'Return online order', phrase: null, score: SEMANTIC_THRESHOLD - 0.01 },
      ],
    });
    vi.mocked(getSql).mockReturnValue(sql as never);
    const m = await matchSkills(USER, 'quit paying for Lumen', 3);
    expect(m).toEqual([{ skillId: CANCEL, title: 'Cancel subscription', score: 0.93, matchedPhrase: 'stop paying for this' }]);
    expect(sql.calls).toHaveLength(1);
  });

  it('returns nothing when every semantic score is under the threshold (no keyword rescue)', async () => {
    vi.mocked(embed).mockResolvedValue([[0.1]]);
    vi.mocked(getSql).mockReturnValue(
      fakeSql({ semantic: () => [{ skill_id: CANCEL, title: 'Cancel subscription', phrase: 'x', score: 0.5 }], keyword: () => kwRows }) as never,
    );
    expect(await matchSkills(USER, 'stop paying for this weather', 3)).toEqual([]);
  });

  it('falls back to keywords when the gateway errors', async () => {
    vi.mocked(embed).mockRejectedValue(new Error('Neon AI Gateway /v1/embeddings 503'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getSql).mockReturnValue(fakeSql({ keyword: () => kwRows }) as never);
    const m = await matchSkills(USER, 'stop paying for this', 3);
    expect(m[0]).toMatchObject({ skillId: CANCEL, score: 1, matchedPhrase: 'stop paying for this' });
    warn.mockRestore();
  });

  it('uses keywords for skills that have no embeddings yet', async () => {
    vi.mocked(embed).mockResolvedValue([[0.1]]);
    const sql = fakeSql({
      semantic: () => [
        { skill_id: CANCEL, title: 'Cancel subscription', phrase: 'cancel subscription', score: 0.4 },
        { skill_id: RETURN, title: 'Return online order', phrase: null, score: null },
      ],
      keyword: () => kwRows.filter((r) => r.skill_id === RETURN),
    });
    vi.mocked(getSql).mockReturnValue(sql as never);
    const m = await matchSkills(USER, 'return my order please', 3);
    expect(m).toEqual([{ skillId: RETURN, title: 'Return online order', score: 1, matchedPhrase: 'return my order' }]);
    expect(sql.calls).toHaveLength(2);
  });

  it('short-circuits on empty text', async () => {
    const e = vi.mocked(embed).mockResolvedValue([[1]]);
    expect(await matchSkills(USER, '   ', 3)).toEqual([]);
    expect(e).not.toHaveBeenCalled();
  });
});

// ── Neon integration (real gateway + your branch)
const enabled = process.env.RUN_DB_TESTS === '1';

describe.skipIf(!enabled)('matchSkills (Neon integration)', () => {
  let ids: { CANCEL_SKILL_ID: string; RETURN_SKILL_ID: string; DEMO_USER_ID: string };
  const RETURN_TRIGGERS = ['return online order', 'return my order', 'send this item back', 'start a return', 'get a refund for my purchase'];
  let returnBefore: { status: string; phrases: string[] } | null = null;

  beforeAll(async () => {
    ids = await import('@/lib/neon/seed-data');
    const sql = real.getSql!() as ReturnType<typeof getSql>;
    const [s] = await sql`SELECT status FROM personal_skills WHERE id = ${ids.RETURN_SKILL_ID}`;
    const ph = await sql`SELECT phrase FROM skill_triggers WHERE skill_id = ${ids.RETURN_SKILL_ID}`;
    returnBefore = { status: s.status, phrases: ph.map((r) => r.phrase as string) };
    await sql`UPDATE personal_skills SET status = 'active' WHERE id = ${ids.RETURN_SKILL_ID}`;
    for (const p of RETURN_TRIGGERS) {
      await sql`INSERT INTO skill_triggers (skill_id, user_id, phrase) VALUES (${ids.RETURN_SKILL_ID}, ${ids.DEMO_USER_ID}, ${p})
        ON CONFLICT (skill_id, phrase) DO NOTHING`;
    }
    expect(await embedSkillTriggers(ids.CANCEL_SKILL_ID)).toBeGreaterThan(1);
    expect(await embedSkillTriggers(ids.RETURN_SKILL_ID)).toBe(RETURN_TRIGGERS.length + 1);
  }, 60_000);

  afterAll(async () => {
    if (!returnBefore) return;
    const sql = real.getSql!() as ReturnType<typeof getSql>;
    await sql`DELETE FROM skill_triggers WHERE skill_id = ${ids.RETURN_SKILL_ID} AND NOT (phrase = ANY(${returnBefore.phrases}::text[]))`;
    await sql`DELETE FROM skill_profile_embeddings WHERE skill_id = ${ids.RETURN_SKILL_ID}`;
    await sql`UPDATE personal_skills SET status = ${returnBefore.status} WHERE id = ${ids.RETURN_SKILL_ID}`;
  });

  const cases: [string, 'cancel' | 'return' | null][] = [
    ['Get rid of this subscription', 'cancel'],
    ['stop paying for this', 'cancel'],
    ["I don't want Lumen anymore", 'cancel'],
    ['cancel my membership', 'cancel'],
    ['end my plan before it renews', 'cancel'],
    ['book a haircut', null],
    ["what's the weather", null],
    ['return my headphones', 'return'],
  ];

  it.each(cases)('%s → %s', async (q, want) => {
    const t0 = Date.now();
    const m = await matchSkills(ids.DEMO_USER_ID, q, 3);
    console.log(`[match] ${JSON.stringify(q)} ${Date.now() - t0}ms`, m.map((x) => `${x.title}=${x.score.toFixed(3)}`).join(', ') || '(none)');
    if (want === null) expect(m).toEqual([]);
    else {
      expect(m).toHaveLength(1);
      expect(m[0].skillId).toBe(want === 'cancel' ? ids.CANCEL_SKILL_ID : ids.RETURN_SKILL_ID);
    }
  }, 30_000);
});
