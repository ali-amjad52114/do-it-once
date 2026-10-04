import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveInWorkspace, resolveToken, sanitizeFileName, shellQuote, workspacePath } from './paths';
import { EXEC_TIMEOUT_EXIT, createSpriteWorkspace, type SdkClient, type SdkSprite } from './workspace';
import { extractPdfTextIn, listWorkspaceIn, saveArtifactIn } from './helpers';

const ROOT = '/home/sprite/workspace';

function mockSprite(overrides: Partial<SdkSprite> = {}) {
  const files = new Map<string, Buffer>();
  const fs = {
    readFile: vi.fn(async (p: string) => {
      const b = files.get(p);
      if (!b) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return b;
    }),
    writeFile: vi.fn(async (p: string, d: string | Buffer) => {
      files.set(p, Buffer.from(d));
    }),
    readdir: vi.fn(async (dir: string) =>
      [...files.keys()]
        .filter((k) => k.startsWith(dir + '/'))
        .map((k) => ({ name: k.slice(dir.length + 1), isDirectory: () => false })),
    ),
    stat: vi.fn(async (p: string) => ({ size: files.get(p)?.length ?? 0 })),
  };
  const execFile = vi.fn(async (_file: string, _args?: string[], _o?: unknown) => ({ stdout: '', stderr: '', exitCode: 0 }));
  const sprite: SdkSprite = {
    name: 'do-it-once-agent',
    url: 'https://do-it-once-agent.sprites.app',
    status: 'warm',
    execFile,
    filesystem: () => fs,
    ...overrides,
  };
  return { sprite, fs, files, execFile };
}

function mockClient(sprite: SdkSprite, opts: { missing?: boolean } = {}) {
  const client = {
    getSprite: vi.fn(async () => {
      if (opts.missing) throw Object.assign(new Error('sprite not found'), { name: 'APIError', statusCode: 404 });
      return sprite;
    }),
    createSprite: vi.fn(async () => sprite),
  } satisfies SdkClient;
  return client;
}

describe('paths', () => {
  it('builds workspace paths and sanitises file names', () => {
    expect(workspacePath(ROOT, 'receipts', 'Lumen receipt #42.pdf')).toBe(`${ROOT}/receipts/Lumen-receipt-42.pdf`);
    expect(workspacePath(ROOT, 'return-labels', '../../etc/passwd')).toBe(`${ROOT}/return-labels/passwd`);
    expect(workspacePath(ROOT, 'artifacts', 'C:\\tmp\\shot.png')).toBe(`${ROOT}/artifacts/shot.png`);
    expect(sanitizeFileName('...')).toMatch(/^file-\d+$/);
    expect(() => workspacePath(ROOT, 'nope' as never, 'x')).toThrow(/Unknown workspace folder/);
  });

  it('resolves relative paths against the root', () => {
    expect(resolveInWorkspace(ROOT, 'receipts/a.pdf')).toBe(`${ROOT}/receipts/a.pdf`);
    expect(resolveInWorkspace(ROOT, '/tmp/x/')).toBe('/tmp/x');
    expect(resolveInWorkspace(ROOT, '/')).toBe('/');
  });

  it('shell-quotes single quotes', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe('token', () => {
  it('throws a clear error when missing', () => {
    expect(() => resolveToken({})).toThrow(/SPRITES_TOKEN.*sprites\.dev\/account/);
    expect(() => resolveToken({ SPRITES_TOKEN: '  ' })).toThrow(/SPRITES_TOKEN/);
  });
  it('prefers SPRITES_TOKEN then SPRITE_TOKEN', () => {
    expect(resolveToken({ SPRITES_TOKEN: 'a', SPRITE_TOKEN: 'b' })).toBe('a');
    expect(resolveToken({ SPRITE_TOKEN: 'b' })).toBe('b');
  });

  describe('getWorkspace', () => {
    const saved = { a: process.env.SPRITES_TOKEN, b: process.env.SPRITE_TOKEN };
    afterEach(() => {
      process.env.SPRITES_TOKEN = saved.a;
      process.env.SPRITE_TOKEN = saved.b;
      if (saved.a === undefined) delete process.env.SPRITES_TOKEN;
      if (saved.b === undefined) delete process.env.SPRITE_TOKEN;
      delete (globalThis as Record<symbol, unknown>)[Symbol.for('doitonce.fly.workspace')];
    });
    it('throws without a token and is a singleton with one', async () => {
      delete process.env.SPRITES_TOKEN;
      delete process.env.SPRITE_TOKEN;
      delete (globalThis as Record<symbol, unknown>)[Symbol.for('doitonce.fly.workspace')];
      const { getWorkspace } = await import('./index');
      expect(() => getWorkspace()).toThrow(/SPRITES_TOKEN/);
      process.env.SPRITES_TOKEN = 'org/id/tok/value';
      expect(getWorkspace()).toBe(getWorkspace());
    });
  });
});

describe('createSpriteWorkspace', () => {
  it('ensure() gets an existing sprite and mkdirs the folders once', async () => {
    const { sprite, execFile } = mockSprite();
    const client = mockClient(sprite);
    const ws = createSpriteWorkspace(client, { spriteName: 'do-it-once-agent', root: ROOT });
    const info = await ws.ensure();
    await ws.ensure();
    expect(info).toMatchObject({ name: 'do-it-once-agent', root: ROOT, url: 'https://do-it-once-agent.sprites.app', created: false, statusBefore: 'warm' });
    expect(client.createSprite).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args] = execFile.mock.calls[0];
    expect(file).toBe('bash');
    expect(args?.[0]).toBe('-lc');
    for (const d of ['receipts', 'downloads', 'return-labels', 'statements', 'artifacts']) expect(args?.[1]).toContain(`'${ROOT}/${d}'`);
  });

  it('ensure() creates the sprite on 404', async () => {
    const { sprite } = mockSprite();
    const client = mockClient(sprite, { missing: true });
    const ws = createSpriteWorkspace(client, { spriteName: 'do-it-once-agent', root: ROOT });
    const info = await ws.ensure();
    expect(client.createSprite).toHaveBeenCalledWith('do-it-once-agent', expect.objectContaining({ urlSettings: { auth: 'sprite' } }));
    expect(info.created).toBe(true);
  });

  it('ensure() propagates non-404 errors and retries next time', async () => {
    const { sprite } = mockSprite();
    const client = mockClient(sprite);
    client.getSprite.mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { statusCode: 401 }));
    const ws = createSpriteWorkspace(client, { spriteName: 's', root: ROOT });
    await expect(ws.ensure()).rejects.toThrow('unauthorized');
    await expect(ws.ensure()).resolves.toMatchObject({ root: ROOT });
  });

  it('exec wraps commands in bash -lc with cwd and timeout', async () => {
    const { sprite, execFile } = mockSprite();
    const ws = createSpriteWorkspace(mockClient(sprite), { spriteName: 's', root: ROOT });
    execFile.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // mkdir
    execFile.mockResolvedValueOnce({ stdout: Buffer.from('hi\n') as unknown as string, stderr: '', exitCode: 0 });
    const r = await ws.exec('echo hi | cat', { timeoutMs: 1234 });
    expect(r).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 0 });
    expect(execFile).toHaveBeenLastCalledWith('bash', ['-lc', 'echo hi | cat'], { cwd: ROOT, timeout: 1234 });
    await ws.exec('pwd', { cwd: '/tmp' });
    expect(execFile).toHaveBeenLastCalledWith('bash', ['-lc', 'pwd'], { cwd: '/tmp', timeout: 120_000 });
  });

  it('exec returns non-zero exits (ExecError) and timeouts as results', async () => {
    const { sprite, execFile } = mockSprite();
    const ws = createSpriteWorkspace(mockClient(sprite), { spriteName: 's', root: ROOT });
    await ws.ensure();
    const execErr = Object.assign(new Error('Command failed with exit code 2'), {
      name: 'ExecError',
      result: {},
      exitCode: 2,
      stdout: 'partial',
      stderr: 'boom',
    });
    execFile.mockRejectedValueOnce(execErr);
    expect(await ws.exec('false')).toEqual({ stdout: 'partial', stderr: 'boom', exitCode: 2 });
    execFile.mockRejectedValueOnce(new Error('Command timed out after 10 ms'));
    expect(await ws.exec('sleep 9', { timeoutMs: 10 })).toMatchObject({ exitCode: EXEC_TIMEOUT_EXIT });
    execFile.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(ws.exec('ls')).rejects.toThrow('socket hang up');
  });

  it('write/read/list go through the filesystem API with absolute paths', async () => {
    const { sprite, fs } = mockSprite();
    const ws = createSpriteWorkspace(mockClient(sprite), { spriteName: 's', root: ROOT });
    await ws.writeFile('artifacts/a.txt', 'hello');
    expect(fs.writeFile).toHaveBeenCalledWith(`${ROOT}/artifacts/a.txt`, 'hello');
    expect((await ws.readFile(`${ROOT}/artifacts/a.txt`)).toString()).toBe('hello');
    expect(await ws.list('artifacts')).toEqual([{ path: `${ROOT}/artifacts/a.txt`, size: 5, isDir: false }]);
  });
});

describe('helpers', () => {
  it('saveArtifact returns path and sprite: location', async () => {
    const { sprite, files } = mockSprite();
    const ws = createSpriteWorkspace(mockClient(sprite), { spriteName: 'h1', root: ROOT });
    const r = await saveArtifactIn(ws, 'receipts', 'order 1.pdf', new Uint8Array([1, 2, 3]));
    expect(r).toEqual({ path: `${ROOT}/receipts/order-1.pdf`, location: `sprite:${ROOT}/receipts/order-1.pdf` });
    expect(files.get(r.path)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('extractPdfText uses pdftotext when present', async () => {
    const { sprite, execFile } = mockSprite();
    execFile.mockImplementation(async (_f, args) => {
      const cmd = args?.[1] ?? '';
      if (cmd.startsWith('command -v')) return { stdout: '/usr/bin/pdftotext\n', stderr: '', exitCode: 0 };
      if (cmd.startsWith('pdftotext')) return { stdout: 'Hello PDF', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const ws = createSpriteWorkspace(mockClient(sprite), { spriteName: 'h2', root: ROOT });
    expect(await extractPdfTextIn(ws, 'artifacts/x.pdf')).toEqual({ text: 'Hello PDF', tool: 'pdftotext', installed: false });
    expect(execFile.mock.calls.at(-1)?.[1]?.[1]).toBe(`pdftotext -layout -enc UTF-8 '${ROOT}/artifacts/x.pdf' -`);
  });

  it('extractPdfText returns null with a reason when it cannot install', async () => {
    const { sprite, execFile } = mockSprite();
    execFile.mockImplementation(async (_f, args) => {
      const cmd = args?.[1] ?? '';
      if (cmd.startsWith('command -v') || cmd.startsWith('sudo -n true')) {
        throw Object.assign(new Error('exit 1'), { name: 'ExecError', result: {}, exitCode: 1, stdout: '', stderr: '' });
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const ws = createSpriteWorkspace(mockClient(sprite), { spriteName: 'h3', root: ROOT });
    const r = await extractPdfTextIn(ws, '/x.pdf');
    expect(r.text).toBeNull();
    expect('reason' in r && r.reason).toMatch(/sudo/);
  });

  it('listWorkspace builds a tree of the five folders', async () => {
    const { sprite } = mockSprite();
    const ws = createSpriteWorkspace(mockClient(sprite), { spriteName: 'h4', root: ROOT });
    await saveArtifactIn(ws, 'artifacts', 'b.png', Buffer.alloc(10));
    await saveArtifactIn(ws, 'artifacts', 'a.pdf', Buffer.alloc(5));
    const tree = await listWorkspaceIn(ws);
    expect(tree.folders.map((f) => f.kind)).toEqual(['receipts', 'downloads', 'return-labels', 'statements', 'artifacts']);
    const art = tree.folders.find((f) => f.kind === 'artifacts')!;
    expect(art.children?.map((c) => c.name)).toEqual(['a.pdf', 'b.png']);
    expect(art).toMatchObject({ fileCount: 2, totalBytes: 15 });
  });
});
