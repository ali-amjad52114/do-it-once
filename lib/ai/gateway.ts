// Neon AI Gateway client — every model call in the app goes through here (server-only).
// OpenAI-compatible endpoints: POST {base}/v1/chat/completions and {base}/v1/embeddings.
import type { z } from 'zod';
import { env } from '@/lib/env';

export const MODELS = {
  fast: 'claude-haiku-4-5', // classification, short judgments
  smart: 'claude-sonnet-4-6', // planning, normalizing traces, healing
  embed: 'qwen3-embedding-0-6b', // 1024 dims → skill_triggers.embedding vector(1024)
} as const;

export const EMBEDDING_DIMS = 1024;

function base() {
  return env('NEON_AI_GATEWAY_BASE_URL').replace(/\/$/, '');
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('NEON_AI_GATEWAY_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Neon AI Gateway ${path} ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** Plain chat completion; returns the assistant text. */
export async function chat(opts: {
  system?: string;
  user: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  const messages = [
    ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
    { role: 'user', content: opts.user },
  ];
  const data = await post<{ choices: { message: { content: string } }[] }>('/v1/chat/completions', {
    model: opts.model ?? MODELS.fast,
    messages,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0,
  });
  return data.choices?.[0]?.message?.content ?? '';
}

/** Chat completion that must return JSON matching `schema` (one retry with the validation error). */
export async function chatJSON<S extends z.ZodTypeAny>(opts: {
  system: string;
  user: string;
  schema: S;
  model?: string;
  maxTokens?: number;
}): Promise<z.infer<S>> {
  const system = `${opts.system}\n\nRespond with ONLY a JSON object. No prose, no code fences.`;
  let user = opts.user;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await chat({ system, user, model: opts.model, maxTokens: opts.maxTokens });
    const json = extractJson(text);
    const parsed = opts.schema.safeParse(json);
    if (parsed.success) return parsed.data;
    user = `${opts.user}\n\nYour previous answer was invalid: ${parsed.error.message.slice(0, 500)}. Return valid JSON only.`;
  }
  throw new Error('Neon AI Gateway: model did not return valid JSON');
}

/** Embeds texts (batch). Returns one 1024-dim vector per input, in order. */
export async function embed(texts: string[], model: string = MODELS.embed): Promise<number[][]> {
  if (texts.length === 0) return [];
  const data = await post<{ data: { index: number; embedding: number[] }[] }>('/v1/embeddings', { model, input: texts });
  return [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/** pgvector literal for a vector: '[0.1,0.2,...]'. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

function extractJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}
