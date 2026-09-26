import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { configureProjectMemory, forgetFact, loadProjectMemory, rememberFact } from '../src/utils/projectMemory';

vi.mock('../src/utils/logger', () => ({ log: vi.fn() }));
vi.mock('vscode', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const uri = (file: string, scheme = 'file') => ({ fsPath: file, path: file, scheme });
  return {
    Uri: { file: uri, joinPath: (base: ReturnType<typeof uri>, ...parts: string[]) => uri(path.join(base.fsPath, ...parts), base.scheme) },
    workspace: {
      workspaceFolders: undefined,
      fs: {
        readFile: (u: ReturnType<typeof uri>) => fs.readFile(u.fsPath),
        writeFile: (u: ReturnType<typeof uri>, body: Uint8Array) => fs.writeFile(u.fsPath, body),
        createDirectory: (u: ReturnType<typeof uri>) => fs.mkdir(u.fsPath, { recursive: true }),
        rename: (from: ReturnType<typeof uri>, to: ReturnType<typeof uri>) => fs.rename(from.fsPath, to.fsPath),
        delete: (u: ReturnType<typeof uri>) => fs.unlink(u.fsPath),
      },
    },
  };
});

let root: string;
let storage: string;
let project: string;
const markdown = (...facts: string[]) => '# CodeFlare project memory\n\n' + facts.join('\n') + '\n';
const memoryFile = () => path.join(storage, 'memory', 'memory.md');
const legacyFile = () => path.join(project, '.codeflare', 'memory.md');
async function put(file: string, body: string | Uint8Array) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'cf-project-memory-'));
  storage = path.join(root, 'workspace-storage');
  project = path.join(root, 'project');
  await fs.mkdir(project);
  configureProjectMemory(vscode.Uri.file(storage), vscode.Uri.file(project));
});
afterEach(async () => {
  vi.restoreAllMocks();
  configureProjectMemory(undefined, undefined);
  const resolved = path.resolve(root);
  if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolved).startsWith('cf-project-memory-')) {
    throw new Error('Unsafe temporary test cleanup');
  }
  await fs.rm(resolved, { recursive: true, force: true });
});

describe('workspace project memory', () => {
  it('stores facts in VS Code storage without creating files in the project', async () => {
    expect(await rememberFact('Build using npm run build', 'build')).toContain('Remembered');
    expect(await loadProjectMemory()).toBe('- [build] Build using npm run build');
    expect(await fs.readFile(memoryFile(), 'utf8')).toContain('Build using npm run build');
    expect(await fs.readdir(project)).toEqual([]);
    expect(await fs.readdir(path.join(storage, 'memory'))).toEqual(['memory.md']);
  });

  it('migrates legacy facts once, merges exact duplicate bodies, and preserves the source', async () => {
    const legacy = markdown('- [build] Build using npm run build', '- [tests] Run tests with npm test');
    await put(legacyFile(), legacy);
    await put(memoryFile(), markdown('- [stack] Uses TypeScript', '- [build] Build using npm run build'));
    expect(await loadProjectMemory()).toBe('- [stack] Uses TypeScript\n- [build] Build using npm run build\n- [tests] Run tests with npm test');
    expect(await fs.readFile(legacyFile(), 'utf8')).toBe(legacy);
    await put(legacyFile(), legacy + '- A fact added after migration\n');
    expect(await loadProjectMemory()).not.toContain('after migration');
  });

  it('never resurrects forgotten legacy facts after reactivation', async () => {
    await put(legacyFile(), markdown('- [tests] Run tests with npm test'));
    expect(await forgetFact('npm test')).toContain('Forgot 1');
    configureProjectMemory(vscode.Uri.file(storage), vscode.Uri.file(project));
    expect(await loadProjectMemory()).toBe('');
    expect(await fs.readFile(legacyFile(), 'utf8')).toContain('npm test');
  });

  it('keeps facts isolated between workspaces', async () => {
    await rememberFact('Project A uses TypeScript', 'stack');
    const otherStorage = path.join(root, 'other-storage');
    configureProjectMemory(vscode.Uri.file(otherStorage), undefined);
    expect(await loadProjectMemory()).toBe('');
    await rememberFact('Project B uses Python', 'stack');
    configureProjectMemory(vscode.Uri.file(storage), vscode.Uri.file(project));
    expect(await loadProjectMemory()).toContain('Project A');
    expect(await loadProjectMemory()).not.toContain('Project B');
  });

  it('reports unavailable storage and never falls back to project or global memory', async () => {
    await put(legacyFile(), markdown('- Legacy fact'));
    configureProjectMemory(undefined, vscode.Uri.file(project));
    expect(await rememberFact('Use npm to build')).toContain('Project memory unavailable');
    expect(await forgetFact('Legacy')).toContain('Project memory unavailable');
    expect(await loadProjectMemory()).toBe('');
    await expect(fs.stat(storage)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(legacyFile(), 'utf8')).toBe(markdown('- Legacy fact'));
  });

  it.each(['{"broken":true}', '# CodeFlare project memory\n<!-- interrupted comment', 'unrecognized handwritten text'])('preserves a corrupt destination (%s)', async body => {
    await put(memoryFile(), body);
    await put(legacyFile(), markdown('- Legacy fact'));
    expect(await rememberFact('Run tests with npm test')).toContain('Failed to save fact');
    expect(await forgetFact('anything')).toContain('Failed to update memory');
    await expect(loadProjectMemory()).rejects.toThrow('unrecognized content');
    expect(await fs.readFile(memoryFile(), 'utf8')).toBe(body);
  });

  it('preserves invalid UTF-8 and propagates read permission failures', async () => {
    const invalid = Buffer.from([0xff, 0xfe]);
    await put(memoryFile(), invalid);
    expect(await rememberFact('Run tests with npm test')).toContain('Failed to save fact');
    expect(await fs.readFile(memoryFile())).toEqual(invalid);
    await put(memoryFile(), markdown('- Existing fact'));
    const originalRead = vscode.workspace.fs.readFile;
    vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(async uri => {
      if (uri.fsPath === memoryFile()) { throw Object.assign(new Error('Access denied'), { code: 'NoPermissions' }); }
      return originalRead(uri);
    });
    expect(await rememberFact('Run tests with npm test')).toContain('Access denied');
    expect(await fs.readFile(memoryFile(), 'utf8')).toBe(markdown('- Existing fact'));
  });

  it('does not mark failed legacy reads as migrated', async () => {
    await put(legacyFile(), 'broken legacy content');
    expect(await rememberFact('Use npm to build')).toContain('Failed to save fact');
    await expect(fs.stat(memoryFile())).rejects.toMatchObject({ code: 'ENOENT' });
    await put(legacyFile(), markdown('- Legacy durable fact'));
    expect(await loadProjectMemory()).toBe('- Legacy durable fact');
  });

  it('serializes simultaneous updates without dropping facts', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => rememberFact(`Command tool ${i} must run from the workspace`, `tool${i}`)));
    expect(results.every(result => result.startsWith('Remembered'))).toBe(true);
    expect((await loadProjectMemory()).split('\n')).toHaveLength(20);
  });

  it('coordinates independent extension-host instances through an exclusive storage lock', async () => {
    vi.resetModules();
    const otherHost = await import('../src/utils/projectMemory');
    otherHost.configureProjectMemory(vscode.Uri.file(storage), vscode.Uri.file(project));
    const results = await Promise.all([
      ...Array.from({ length: 8 }, (_, i) => rememberFact(`First workspace tool ${i} runs via a local binary`, 'first')),
      ...Array.from({ length: 8 }, (_, i) => otherHost.rememberFact(`Second workspace tool ${i} runs via a local binary`, 'second')),
    ]);
    expect(results.every(result => result.startsWith('Remembered'))).toBe(true);
    expect((await loadProjectMemory()).split('\n')).toHaveLength(16);
  });

  it('preserves the last committed store when the atomic rename fails', async () => {
    await rememberFact('Existing durable build instruction', 'build');
    const before = await fs.readFile(memoryFile(), 'utf8');
    vi.spyOn(vscode.workspace.fs, 'rename').mockRejectedValue(new Error('Rename denied'));
    expect(await rememberFact('Another durable test instruction', 'tests')).toContain('Rename denied');
    expect(await fs.readFile(memoryFile(), 'utf8')).toBe(before);
    expect(await fs.readdir(path.join(storage, 'memory'))).toEqual(['memory.md']);
  });

  it('preserves deduplication, refinement, executable facts, and trivia filtering', async () => {
    expect(await rememberFact('file build.ts defines function runBuild', 'build')).toContain('Not remembered');
    expect(await rememberFact('Run npm run build', 'build')).toContain('Remembered');
    expect(await rememberFact('Run npm run build:prod', 'build')).toContain('Refined');
    expect(await rememberFact('Run npm run build', 'build')).toContain('Already known');
    expect(await rememberFact('python = C:\\Tools\\python.exe', 'exe')).toContain('Remembered');
    expect(await loadProjectMemory()).toContain('- [exe] python = C:\\Tools\\python.exe');
  });

  it('preserves markup inside a durable fact instead of interpreting it as store metadata', async () => {
    const fact = 'The HTML renderer preserves <!-- keep --> comments during release builds';
    expect(await rememberFact(fact, 'build')).toContain('Remembered');
    expect(await loadProjectMemory()).toBe('- [build] ' + fact);
    expect(await rememberFact(fact, 'build')).toContain('Already known');
  });

  it('uses the URI provider for non-file workspace storage', async () => {
    const uri = { ...vscode.Uri.file(storage), scheme: 'test-storage' } as vscode.Uri;
    configureProjectMemory(uri, vscode.Uri.file(project));
    expect(await rememberFact('Uses a URI-backed storage provider', 'storage')).toContain('Remembered');
    expect(await loadProjectMemory()).toContain('URI-backed storage provider');
  });
});
