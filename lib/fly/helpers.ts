// Higher-level workspace helpers (artifact saving, PDF text, UI tree). SERVER-ONLY.
import { posix } from 'node:path';
import { WORKSPACE_KINDS, shellQuote, workspaceLocation, workspacePath, type WorkspaceKind } from './paths';
import type { SpriteWorkspace } from './workspace';

export interface SavedArtifact {
  path: string; // absolute path inside the Sprite
  location: string; // "sprite:<path>"
}

export async function saveArtifactIn(
  ws: SpriteWorkspace,
  kind: WorkspaceKind,
  fileName: string,
  bytes: Buffer | Uint8Array | string,
): Promise<SavedArtifact> {
  const path = workspacePath(ws.root, kind, fileName);
  await ws.writeFile(path, typeof bytes === 'string' ? bytes : Buffer.from(bytes));
  return { path, location: workspaceLocation(path) };
}

export type PdfTextResult =
  | { text: string; tool: 'pdftotext'; installed: boolean }
  | { text: null; reason: string };

const INSTALL_KEY = Symbol.for('doitonce.fly.pdftotextInstall');
type InstallState = Map<string, Promise<{ ok: boolean; installed: boolean; reason?: string }>>;
function installState(): InstallState {
  const g = globalThis as unknown as Record<symbol, InstallState | undefined>;
  return (g[INSTALL_KEY] ??= new Map());
}

/** Make sure pdftotext exists in the Sprite; installs poppler-utils once if passwordless sudo apt works. */
export function ensurePdftotext(ws: SpriteWorkspace) {
  const state = installState();
  let p = state.get(ws.spriteName);
  if (!p) {
    p = (async () => {
      const has = await ws.exec('command -v pdftotext', { timeoutMs: 30_000 });
      if (has.exitCode === 0 && has.stdout.trim()) return { ok: true, installed: false };
      const sudo = await ws.exec('sudo -n true', { timeoutMs: 30_000 });
      if (sudo.exitCode !== 0) {
        return { ok: false, installed: false, reason: 'pdftotext is not installed and passwordless sudo is unavailable to install poppler-utils' };
      }
      const install = await ws.exec(
        'sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq poppler-utils',
        { timeoutMs: 300_000 },
      );
      if (install.exitCode !== 0) {
        return { ok: false, installed: false, reason: `apt-get install poppler-utils failed (exit ${install.exitCode}): ${install.stderr.trim().slice(-400)}` };
      }
      return { ok: true, installed: true };
    })();
    state.set(ws.spriteName, p);
    // Don't cache transport failures; do cache "no sudo" (a definitive answer).
    p.catch(() => state.delete(ws.spriteName));
  }
  return p;
}

export async function extractPdfTextIn(ws: SpriteWorkspace, path: string): Promise<PdfTextResult> {
  const tool = await ensurePdftotext(ws);
  if (!tool.ok) return { text: null, reason: tool.reason ?? 'pdftotext unavailable' };
  const abs = path.startsWith('/') ? path : posix.join(ws.root, path);
  const r = await ws.exec(`pdftotext -layout -enc UTF-8 ${shellQuote(abs)} -`, { timeoutMs: 60_000 });
  if (r.exitCode !== 0) return { text: null, reason: `pdftotext failed (exit ${r.exitCode}): ${r.stderr.trim()}` };
  return { text: r.stdout, tool: 'pdftotext', installed: tool.installed };
}

export interface WorkspaceTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  children?: WorkspaceTreeNode[];
}

export interface WorkspaceTree {
  sprite: string;
  root: string;
  folders: Array<WorkspaceTreeNode & { kind: WorkspaceKind; fileCount: number; totalBytes: number }>;
}

/** Root + the five known folders, each with its direct entries (sorted, dirs first). */
export async function listWorkspaceIn(ws: SpriteWorkspace): Promise<WorkspaceTree> {
  await ws.ensure();
  const folders = await Promise.all(
    WORKSPACE_KINDS.map(async (kind) => {
      const dirPath = `${ws.root}/${kind}`;
      const entries = await ws.list(dirPath).catch(() => []);
      const children: WorkspaceTreeNode[] = entries
        .map((e) => ({ name: posix.basename(e.path), path: e.path, isDir: e.isDir, size: e.size }))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
      const files = children.filter((c) => !c.isDir);
      return {
        kind,
        name: kind,
        path: dirPath,
        isDir: true,
        size: 0,
        children,
        fileCount: files.length,
        totalBytes: files.reduce((n, c) => n + c.size, 0),
      };
    }),
  );
  return { sprite: ws.spriteName, root: ws.root, folders };
}
