import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { checkAgentMutation, withAgentScope } from '../src/engine/agentScope';

let directory: string;
let root: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(tmpdir(), 'cf-scope-physical-'));
  root = path.join(directory, 'workspace');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'upload.ts'), 'export const upload = true;');
});
afterEach(async () => {
  const target = path.resolve(directory);
  if (!target.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(target).startsWith('cf-scope-physical-')) {
    throw new Error('Unsafe physical-scope test cleanup target');
  }
  await fs.rm(target, { recursive: true, force: true });
});

// Junctions exercise native realpath on Windows without requiring symlink privileges.
const linkDirectory = (target: string, alias: string) => fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');

describe('physical agent mutation identity', () => {
  it.each(['upload.ts', 'new/nested/upload.ts'])('shares ownership through a directory link for %s', async file => {
    await linkDirectory(path.join(root, 'src'), path.join(root, 'alias'));
    const owners = new Map<string, string>();
    const changed = new Set<string>();
    await withAgentScope('first', owners, false, changed, async () => {
      expect(checkAgentMutation(`alias/${file}`, true).allowed).toBe(true);
    }, root);
    await withAgentScope('second', owners, false, new Set(), async () => {
      expect(checkAgentMutation(`src/${file}`, true)).toMatchObject({ allowed: false, code: 'PATH_NOT_ALLOWED' });
      expect(checkAgentMutation(path.join(root, 'alias', file), true).allowed).toBe(false);
    }, root);
    expect([...changed]).toEqual([`src/${file}`]);
    expect(owners.size).toBe(1);
  });

  it.each(['upload.ts', 'new/upload.ts'])('cannot turn production into test files through a tests link (%s)', async file => {
    await linkDirectory(path.join(root, 'src'), path.join(root, 'tests'));
    const owners = new Map<string, string>();
    const changed = new Set<string>();
    await withAgentScope('test-author', owners, true, changed, async () => {
      expect(checkAgentMutation(`tests/${file}`, false).allowed).toBe(false);
      expect(checkAgentMutation(`tests/${file}`, true).allowed).toBe(false);
    }, root);
    expect(owners.size).toBe(0);
    expect(changed.size).toBe(0);
  });

  it.each([false, true])('denies a directory link escaping the workspace (testsOnly=%s)', async testsOnly => {
    const outside = path.join(directory, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'upload.test.ts'), 'outside content');
    await linkDirectory(outside, path.join(root, 'tests'));
    const owners = new Map<string, string>();
    const changed = new Set<string>();
    await withAgentScope('worker', owners, testsOnly, changed, async () => {
      expect(checkAgentMutation('tests/upload.test.ts', true).allowed).toBe(false);
      expect(checkAgentMutation('tests/nested/new.test.ts', true).allowed).toBe(false);
    }, root);
    expect(changed.size).toBe(0);
    expect(owners.size).toBe(0);
    expect(await fs.readFile(path.join(outside, 'upload.test.ts'), 'utf8')).toBe('outside content');
  });

  it('normalizes a linked workspace root without rejecting legitimate files or losing ownership', async () => {
    const linkedRoot = path.join(directory, 'linked-workspace');
    await linkDirectory(root, linkedRoot);
    const owners = new Map<string, string>();
    const changed = new Set<string>();
    await withAgentScope('first', owners, false, changed, async () => {
      expect(checkAgentMutation(path.join(root, 'src', 'upload.ts'), true).allowed).toBe(true);
    }, linkedRoot);
    await withAgentScope('second', owners, false, new Set(), async () => {
      expect(checkAgentMutation('src/upload.ts', true).allowed).toBe(false);
    }, root);
    expect([...changed]).toEqual(['src/upload.ts']);
  });
});
