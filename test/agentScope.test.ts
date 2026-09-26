import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { checkAgentMutation, isTestPath, withAgentScope } from '../src/engine/agentScope';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('agent write ownership', () => {
  it('reserves a file on mutation, blocks other agents and keeps coordinator access', async () => {
    const owners = new Map<string, string>();
    const firstFiles = new Set<string>();
    const secondFiles = new Set<string>();
    await withAgentScope('interface', owners, false, firstFiles, async () => {
      expect(checkAgentMutation('./src/Upload.tsx', true).allowed).toBe(true);
      await Promise.resolve();
      expect(checkAgentMutation('src/Upload.tsx', true).allowed).toBe(true);
    });
    await withAgentScope('api', owners, false, secondFiles, async () => {
      const conflict = checkAgentMutation('SRC\\UPLOAD.TSX', true);
      expect(conflict).toMatchObject({ allowed: false, code: 'PATH_NOT_ALLOWED' });
      expect(conflict.reason).toContain('interface');
      expect(checkAgentMutation('src/api.ts', true).allowed).toBe(true);
    });
    expect([...secondFiles]).toEqual(['src/api.ts']);
    expect(firstFiles.size).toBeGreaterThan(0);
    expect(checkAgentMutation('src/Upload.tsx', true).allowed).toBe(true);
  });

  it('does not acquire ownership or report a file change during preflight', async () => {
    const owners = new Map<string, string>();
    const files = new Set<string>();
    await withAgentScope('previewer', owners, false, files, async () => {
      expect(checkAgentMutation('src/shared.ts', false).allowed).toBe(true);
    });
    expect(owners.size).toBe(0);
    expect(files.size).toBe(0);
    await withAgentScope('writer', owners, false, new Set(), async () => {
      expect(checkAgentMutation('src/shared.ts', true).allowed).toBe(true);
    });
    await withAgentScope('previewer', owners, false, files, async () => {
      expect(checkAgentMutation('src/shared.ts', false).allowed).toBe(false);
    });
    expect(files.size).toBe(0);
  });

  it('keeps concurrent async roles and change lists isolated across awaits', async () => {
    const owners = new Map<string, string>();
    const testFiles = new Set<string>();
    const buildFiles = new Set<string>();
    const testerReady = deferred();
    const builderFinished = deferred();
    const tester = withAgentScope('tester', owners, true, testFiles, async () => {
      testerReady.resolve();
      await builderFinished.promise;
      expect(checkAgentMutation('src/app.ts', true).allowed).toBe(false);
      expect(checkAgentMutation('test/app.test.ts', true).allowed).toBe(true);
    });
    const builder = withAgentScope('builder', owners, false, buildFiles, async () => {
      await testerReady.promise;
      try {
        expect(checkAgentMutation('src/app.ts', true).allowed).toBe(true);
        await Promise.resolve();
        expect(checkAgentMutation('src/api.ts', true).allowed).toBe(true);
      } finally {
        builderFinished.resolve();
      }
    });
    await Promise.all([tester, builder]);
    expect([...testFiles]).toEqual(['test/app.test.ts']);
    expect([...buildFiles]).toEqual(['src/app.ts', 'src/api.ts']);
    expect(checkAgentMutation('src/other.ts', true).allowed).toBe(true);
  });

  it('restores a parent scope after a nested failure and removes the role after completion', async () => {
    const owners = new Map<string, string>();
    await withAgentScope('builder', owners, false, new Set(), async () => {
      await expect(withAgentScope('tester', owners, true, new Set(), async () => {
        await Promise.resolve();
        expect(checkAgentMutation('src/inner.ts', true).allowed).toBe(false);
        throw new Error('Test author stopped');
      })).rejects.toThrow('Test author stopped');
      expect(checkAgentMutation('src/outer.ts', true).allowed).toBe(true);
    });
    await expect(withAgentScope('tester', owners, true, new Set(), async () => {
      throw new Error('Cancelled');
    })).rejects.toThrow('Cancelled');
    expect(checkAgentMutation('src/outer.ts', true).allowed).toBe(true);
    expect(checkAgentMutation('src/root.ts', true).allowed).toBe(true);
  });

  it.each(['src/./app.ts', '././src/app.ts', 'src/nested/../app.ts'])
  ('rejects a conflicting write through the equivalent path %s', async alias => {
    const owners = new Map<string, string>();
    await withAgentScope('first', owners, false, new Set(), async () => {
      expect(checkAgentMutation('src/app.ts', true).allowed).toBe(true);
    });
    await withAgentScope('second', owners, false, new Set(), async () => {
      expect(checkAgentMutation(alias, true).allowed).toBe(false);
    });
  });

  it('uses one ownership identity for absolute and relative workspace paths', async () => {
    const root = path.resolve('mission-workspace');
    const owners = new Map<string, string>();
    const changed = new Set<string>();
    await withAgentScope('first', owners, false, changed, async () => {
      expect(checkAgentMutation(path.join(root, 'src/app.ts'), true).allowed).toBe(true);
    }, root);
    await withAgentScope('second', owners, false, new Set(), async () => {
      expect(checkAgentMutation('src/app.ts', true).allowed).toBe(false);
    }, root);
    expect([...changed]).toEqual(['src/app.ts']);
  });

  it('rejects absolute paths without a root and paths outside the supplied root', async () => {
    const root = path.resolve('mission-workspace');
    await withAgentScope('worker', new Map(), false, new Set(), async () => {
      expect(checkAgentMutation(path.join(root, 'src/app.ts'), true).allowed).toBe(false);
    });
    const changed = new Set<string>();
    await withAgentScope('worker', new Map(), false, changed, async () => {
      expect(checkAgentMutation('../other-project/app.ts', true).allowed).toBe(false);
      expect(checkAgentMutation(path.resolve(root, '../other-project/app.ts'), true).allowed).toBe(false);
      expect(checkAgentMutation(root, true).allowed).toBe(false);
      expect(checkAgentMutation('.', true).allowed).toBe(false);
    }, root);
    expect(changed.size).toBe(0);
  });

  it('classifies tests relative to the workspace, ignoring parent folder names', async () => {
    const root = path.resolve('tests', 'mission-workspace');
    const changed = new Set<string>();
    await withAgentScope('tester', new Map(), true, changed, async () => {
      expect(checkAgentMutation(path.join(root, 'src/app.ts'), true).allowed).toBe(false);
      expect(checkAgentMutation(path.join(root, 'test/app.test.ts'), true).allowed).toBe(true);
    }, root);
    expect([...changed]).toEqual(['test/app.test.ts']);
  });
});

describe('test-author file scope', () => {
  it.each([
    'test/upload.test.ts', 'src/upload.spec.tsx', 'src/__tests__/upload.ts',
    'tests/test_upload.py', 'test_upload.py', 'pkg/upload_test.go',
    'spec/upload_spec.rb', 'tests\\upload.spec.cs', 'test/fixtures/upload.json',
    'src/__snapshots__/upload.test.ts.snap',
  ])('allows a supported test or fixture file: %s', async file => {
    expect(isTestPath(file)).toBe(true);
    const changed = new Set<string>();
    await withAgentScope('tests', new Map(), true, changed, async () => {
      expect(checkAgentMutation(file, true).allowed).toBe(true);
    });
    expect([...changed]).toEqual([file.replace(/\\/g, '/')]);
  });

  it.each(['src/upload.ts', 'src/latest.ts', 'contest/main.py', 'package.json', 'vitest.config.ts'])
  ('blocks production and project configuration edits: %s', async file => {
    const owners = new Map<string, string>();
    const changed = new Set<string>();
    await withAgentScope('tests', owners, true, changed, async () => {
      expect(checkAgentMutation(file, true)).toMatchObject({ allowed: false, code: 'PATH_NOT_ALLOWED' });
    });
    expect(owners.size).toBe(0);
    expect(changed.size).toBe(0);
  });

  it.each(['test/../src/app.ts', 'tests\\..\\src\\app.ts'])
  ('cannot escape test scope using an in-workspace traversal: %s', async file => {
    await withAgentScope('tests', new Map(), true, new Set(), async () => {
      expect(checkAgentMutation(file, true).allowed).toBe(false);
    });
  });

  it.each(['tests/package.json', 'test/vitest.config.ts', 'tests/pytest.ini'])
  ('cannot change dependencies or the runner configuration under a test directory: %s', async file => {
    await withAgentScope('tests', new Map(), true, new Set(), async () => {
      expect(checkAgentMutation(file, true).allowed).toBe(false);
    });
  });
});
