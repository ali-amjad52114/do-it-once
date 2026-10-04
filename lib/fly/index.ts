// Fly.io Sprite workspace — the agent's persistent computer. SERVER-ONLY.
// Folders: <root>/{receipts,downloads,return-labels,statements,artifacts}
// Env: SPRITES_TOKEN (fallback SPRITE_TOKEN), optional SPRITE_NAME, SPRITE_WORKSPACE, SPRITES_API_URL.
import { SpritesClient } from '@fly/sprites';
import { SPRITE_NAME_DEFAULT, WORKSPACE_ROOT_DEFAULT, resolveToken, type WorkspaceKind } from './paths';
import { createSpriteWorkspace, type SpriteWorkspace } from './workspace';
import { extractPdfTextIn, listWorkspaceIn, saveArtifactIn, type PdfTextResult, type SavedArtifact, type WorkspaceTree } from './helpers';

if (typeof window !== 'undefined') {
  throw new Error('lib/fly is server-only and must not be imported from client code');
}

export * from './paths';
export { createSpriteWorkspace, EXEC_TIMEOUT_EXIT } from './workspace';
export type { SpriteWorkspace, EnsureInfo } from './workspace';
export type { PdfTextResult, SavedArtifact, WorkspaceTree, WorkspaceTreeNode } from './helpers';

const KEY = Symbol.for('doitonce.fly.workspace');
type G = Record<symbol, SpriteWorkspace | undefined>;

/** True when a Sprites token is configured (lets callers degrade gracefully). */
export function hasSpritesToken(): boolean {
  return !!(process.env.SPRITES_TOKEN?.trim() || process.env.SPRITE_TOKEN?.trim());
}

/** The agent's persistent computer: a Fly.io Sprite with <root>/{receipts,downloads,return-labels,statements,artifacts}. */
export function getWorkspace(): SpriteWorkspace {
  const g = globalThis as unknown as G;
  const existing = g[KEY];
  if (existing) return existing;
  const token = resolveToken(); // throws a clear error when missing
  const client = new SpritesClient(token, {
    timeout: 60_000,
    ...(process.env.SPRITES_API_URL ? { baseURL: process.env.SPRITES_API_URL } : {}),
  });
  const ws = createSpriteWorkspace(client, {
    spriteName: process.env.SPRITE_NAME?.trim() || SPRITE_NAME_DEFAULT,
    root: process.env.SPRITE_WORKSPACE?.trim() || WORKSPACE_ROOT_DEFAULT,
  });
  g[KEY] = ws;
  return ws;
}

/** Save bytes into <root>/<kind>/<fileName>. Returns the in-Sprite path and a "sprite:<path>" location. */
export function saveArtifact(kind: WorkspaceKind, fileName: string, bytes: Buffer | Uint8Array | string): Promise<SavedArtifact> {
  return saveArtifactIn(getWorkspace(), kind, fileName, bytes);
}

/** Extract text from a PDF in the Sprite with pdftotext (installing poppler-utils once if possible). */
export function extractPdfText(path: string): Promise<PdfTextResult> {
  return extractPdfTextIn(getWorkspace(), path);
}

/** Folder tree for the UI. */
export function listWorkspace(): Promise<WorkspaceTree> {
  return listWorkspaceIn(getWorkspace());
}
