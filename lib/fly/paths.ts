// Pure path/shell helpers for the Sprite workspace (no SDK imports, safe to unit test).
import { posix } from 'node:path';

export const SPRITE_NAME_DEFAULT = 'do-it-once-agent';
/** The default user's home is writable without sudo; root-level /workspace is not guaranteed. */
export const WORKSPACE_ROOT_DEFAULT = '/home/sprite/workspace';
export const WORKSPACE_KINDS = ['receipts', 'downloads', 'return-labels', 'statements', 'artifacts'] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export function isWorkspaceKind(v: string): v is WorkspaceKind {
  return (WORKSPACE_KINDS as readonly string[]).includes(v);
}

/** Make a user/agent-supplied file name safe: basename only, no traversal, conservative charset. */
export function sanitizeFileName(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-]+/, '')
    .slice(0, 180);
  return cleaned || `file-${Date.now()}`;
}

/** Absolute in-Sprite path for a file of a given kind, e.g. /home/sprite/workspace/receipts/x.pdf */
export function workspacePath(root: string, kind: WorkspaceKind, fileName: string): string {
  if (!isWorkspaceKind(kind)) throw new Error(`Unknown workspace folder "${kind}"`);
  return posix.join(root, kind, sanitizeFileName(fileName));
}

/** Resolve a path against the workspace root; relative paths are taken as relative to root. */
export function resolveInWorkspace(root: string, p: string): string {
  const abs = p.startsWith('/') ? posix.normalize(p) : posix.join(root, p);
  return abs.length > 1 ? abs.replace(/\/+$/, '') : abs;
}

/** Single-quote a string for bash. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function workspaceLocation(path: string): string {
  return `sprite:${path}`;
}

export function resolveToken(env: Record<string, string | undefined> = process.env): string {
  const token = env.SPRITES_TOKEN?.trim() || env.SPRITE_TOKEN?.trim();
  if (!token) {
    throw new Error(
      'Fly.io Sprites token missing: set SPRITES_TOKEN (or SPRITE_TOKEN) in .env. ' +
        'Create one at https://sprites.dev/account (format org-slug/org-id/token-id/token-value).',
    );
  }
  return token;
}
