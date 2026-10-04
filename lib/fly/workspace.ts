// WorkspaceAdapter backed by a Fly.io Sprite (@fly/sprites). SERVER-ONLY.
// The SDK client is injected (structural types below) so tests can pass a mock.
import type { WorkspaceAdapter, WorkspaceFile } from '@/lib/contracts';
import { WORKSPACE_KINDS, resolveInWorkspace, shellQuote } from './paths';

// ── Minimal structural view of the SDK we depend on (matches @fly/sprites 0.2.3) ──
export interface SdkExecResult {
  stdout: string | Buffer;
  stderr: string | Buffer;
  exitCode: number;
}
export interface SdkDirent {
  name: string;
  isDirectory(): boolean;
}
export interface SdkFilesystem {
  readFile(path: string, encoding: null): Promise<Buffer>;
  writeFile(path: string, data: string | Buffer): Promise<void>;
  readdir(path: string, options: { withFileTypes: true }): Promise<SdkDirent[]>;
  stat(path: string): Promise<{ size: number }>;
}
export interface SdkSprite {
  name: string;
  url?: string;
  status?: string;
  execFile(file: string, args?: string[], options?: { cwd?: string; timeout?: number; env?: Record<string, string> }): Promise<SdkExecResult>;
  filesystem(workingDir?: string): SdkFilesystem;
}
export interface SdkClient {
  getSprite(name: string): Promise<SdkSprite>;
  createSprite(name: string, options?: { urlSettings?: { auth?: string }; labels?: string[] }): Promise<SdkSprite>;
}

export interface SpriteWorkspaceOptions {
  spriteName: string;
  root: string;
  defaultTimeoutMs?: number;
}

export interface EnsureInfo {
  name: string;
  root: string;
  url: string | null;
  /** Sprite status seen before ensure() woke it: 'cold' | 'warm' | 'running' | 'created' */
  statusBefore: string | null;
  created: boolean;
}

export type SpriteWorkspace = Omit<WorkspaceAdapter, 'ensure'> & {
  readonly root: string;
  readonly spriteName: string;
  /** Contract-compatible: EnsureInfo is a superset of { name, root, url }. */
  ensure(): Promise<EnsureInfo>;
};

// Compile-time check: a SpriteWorkspace is assignable to the shared WorkspaceAdapter contract.
const _contractCheck: (w: SpriteWorkspace) => WorkspaceAdapter = (w) => w;
void _contractCheck;

export const EXEC_TIMEOUT_EXIT = 124;

function toStr(v: string | Buffer | undefined | null): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : v.toString('utf8');
}

function isNotFound(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; errorCode?: string; message?: string } | null;
  if (!e) return false;
  if (e.statusCode === 404 || e.status === 404) return true;
  return /not[ _]found|404/i.test(String(e.errorCode ?? '')) || /\b404\b|not found/i.test(String(e.message ?? ''));
}

function isExecError(err: unknown): err is { exitCode: number; stdout: string | Buffer; stderr: string | Buffer } {
  const e = err as { name?: string; result?: unknown; exitCode?: unknown } | null;
  return !!e && typeof e.exitCode === 'number' && (e.name === 'ExecError' || e.result !== undefined);
}

function isTimeout(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  return !!e && (e.name === 'TimeoutError' || e.name === 'AbortError' || /timed out|timeout|aborted/i.test(String(e.message)));
}

export function createSpriteWorkspace(client: SdkClient, opts: SpriteWorkspaceOptions): SpriteWorkspace {
  const { spriteName, root } = opts;
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
  let ensurePromise: Promise<{ sprite: SdkSprite; info: EnsureInfo }> | null = null;

  async function getOrCreate(): Promise<{ sprite: SdkSprite; statusBefore: string | null; created: boolean }> {
    try {
      const sprite = await client.getSprite(spriteName);
      return { sprite, statusBefore: sprite.status ?? null, created: false };
    } catch (err) {
      if (!isNotFound(err)) throw err;
      const sprite = await client.createSprite(spriteName, { urlSettings: { auth: 'sprite' }, labels: ['doitonce'] });
      return { sprite, statusBefore: 'created', created: true };
    }
  }

  async function runExec(sprite: SdkSprite, command: string, o?: { cwd?: string; timeoutMs?: number }) {
    const timeoutMs = o?.timeoutMs ?? defaultTimeoutMs;
    const cwd = o?.cwd ?? root;
    let guard: ReturnType<typeof setTimeout> | undefined;
    const guardPromise = new Promise<never>((_, reject) => {
      // Belt and braces: the SDK honours `timeout`, but also guard against a stuck connect.
      guard = setTimeout(() => reject(Object.assign(new Error(`timed out after ${timeoutMs} ms`), { name: 'TimeoutError' })), timeoutMs + 5_000);
    });
    try {
      const r = await Promise.race([sprite.execFile('bash', ['-lc', command], { cwd, timeout: timeoutMs }), guardPromise]);
      return { stdout: toStr(r.stdout), stderr: toStr(r.stderr), exitCode: r.exitCode ?? 0 };
    } catch (err) {
      if (isExecError(err)) return { stdout: toStr(err.stdout), stderr: toStr(err.stderr), exitCode: err.exitCode };
      if (isTimeout(err)) return { stdout: '', stderr: `Command timed out after ${timeoutMs} ms`, exitCode: EXEC_TIMEOUT_EXIT };
      throw err;
    } finally {
      clearTimeout(guard);
    }
  }

  function ready() {
    if (!ensurePromise) {
      ensurePromise = (async () => {
        const { sprite, statusBefore, created } = await getOrCreate();
        const dirs = [root, ...WORKSPACE_KINDS.map((k) => `${root}/${k}`)].map(shellQuote).join(' ');
        // cwd '/' because root may not exist yet.
        const r = await runExec(sprite, `mkdir -p ${dirs}`, { cwd: '/', timeoutMs: 60_000 });
        if (r.exitCode !== 0) throw new Error(`Could not create workspace folders in Sprite ${spriteName}: ${r.stderr.trim()}`);
        return { sprite, info: { name: sprite.name ?? spriteName, root, url: sprite.url ?? null, statusBefore, created } };
      })();
      ensurePromise.catch(() => {
        ensurePromise = null; // allow retry after a failure
      });
    }
    return ensurePromise;
  }

  const fs = async () => (await ready()).sprite.filesystem('/');
  const abs = (p: string) => resolveInWorkspace(root, p);

  return {
    root,
    spriteName,
    async ensure() {
      return (await ready()).info;
    },
    async writeFile(path, data) {
      await (await fs()).writeFile(abs(path), typeof data === 'string' ? data : Buffer.from(data));
    },
    async readFile(path) {
      return Buffer.from(await (await fs()).readFile(abs(path), null));
    },
    async list(dir) {
      const f = await fs();
      const base = abs(dir);
      const entries = await f.readdir(base, { withFileTypes: true });
      return Promise.all(
        entries.map(async (e): Promise<WorkspaceFile> => {
          const path = base === '/' ? `/${e.name}` : `${base}/${e.name}`;
          const isDir = e.isDirectory();
          let size = 0;
          if (!isDir) {
            try {
              size = (await f.stat(path)).size;
            } catch {
              size = 0;
            }
          }
          return { path, size, isDir };
        }),
      );
    },
    async exec(command, o) {
      const { sprite } = await ready();
      return runExec(sprite, command, o);
    },
  };
}
