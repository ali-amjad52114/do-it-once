// One-time approvals for Executor write tools. The model can't approve its own writes: the chat route marks a
// confirmation approved only when the user's own message carries its code (sent by the Approve button).
import { randomBytes } from 'node:crypto';

interface Pending {
  toolId: string;
  argsKey: string;
  approved: boolean;
  createdAt: number;
}

const TTL_MS = 15 * 60_000;
const CODE = /\bconfirm:([a-f0-9]{10})\b/g;

const g = globalThis as typeof globalThis & { __doItOnceConfirmations?: Map<string, Pending> };
const store = () => (g.__doItOnceConfirmations ??= new Map());

/** Stable JSON (sorted keys at every depth) so approval binds to the exact arguments. */
const stable = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
      : v;
const keyOf = (args: Record<string, unknown>) => JSON.stringify(stable(args));

function prune(now = Date.now()) {
  for (const [id, p] of store()) if (now - p.createdAt > TTL_MS) store().delete(id);
}

/** Registers a pending write and returns its confirmation id. */
export function requestConfirmation(toolId: string, args: Record<string, unknown>): string {
  prune();
  const id = randomBytes(5).toString('hex');
  store().set(id, { toolId, argsKey: keyOf(args), approved: false, createdAt: Date.now() });
  return id;
}

/** Marks every confirmation code found in a user's message as approved. Returns the ids approved. */
export function approveFromUserText(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(CODE)) {
    const p = store().get(m[1]);
    if (p) {
      p.approved = true;
      ids.push(m[1]);
    }
  }
  return ids;
}

/** True once (then forgotten) when this exact tool + arguments was approved by the user. */
export function consumeConfirmation(id: string | undefined, toolId: string, args: Record<string, unknown>): boolean {
  if (!id) return false;
  const p = store().get(id);
  if (!p || !p.approved || p.toolId !== toolId || p.argsKey !== keyOf(args)) return false;
  store().delete(id);
  return true;
}

