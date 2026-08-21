import { beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acceptIsolation,
  beginIsolation,
  gitStatus,
  parkIsolation,
  rejectIsolation,
} from '../src/engine/gitIsolation';

function sh(cwd: string, args: string[]): string {
  return execFileSync('git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@local', ...args],
    { cwd, encoding: 'utf8', timeout: 15000 });
}

/** Fresh repo with one committed file on a known base branch. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-git-test-'));
  sh(dir, ['init', '-b', 'main']);
  // Keep bytes stable on Windows so content assertions are exact.
  sh(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'app.js'), 'const x = 1;\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-m', 'known good']);
  return dir;
}

let repo: string;
beforeEach(() => { repo = makeRepo(); });

describe('gitStatus', () => {
  it('reports a clean repo on its branch', async () => {
    const s = await gitStatus(repo);
    expect(s.isRepo).toBe(true);
    expect(s.branch).toBe('main');
    expect(s.dirty).toBe(false);
    expect(s.headCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports a non-repo directory as not isolatable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-git-norepo-'));
    const s = await gitStatus(dir);
    expect(s.gitAvailable).toBe(true);
    expect(s.isRepo).toBe(false);
  });

  it('detects dirty files', async () => {
    writeFileSync(join(repo, 'app.js'), 'const x = 2;\n');
    const s = await gitStatus(repo);
    expect(s.dirty).toBe(true);
    expect(s.dirtyFiles).toContain('app.js');
  });
});

describe('beginIsolation', () => {
  it('creates and switches to an experiment branch on a clean repo', async () => {
    const r = await beginIsolation(repo, 'exp-1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.isolation.baseBranch).toBe('main');
      expect((await gitStatus(repo)).branch).toBe(r.isolation.branch);
    }
  });

  it('REFUSES a dirty working tree and leaves user work untouched', async () => {
    writeFileSync(join(repo, 'app.js'), 'USER WORK IN PROGRESS\n');
    const r = await beginIsolation(repo, 'exp-2');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toContain('uncommitted'); }
    // The user's edit is exactly where they left it — no stash, no reset.
    expect(readFileSync(join(repo, 'app.js'), 'utf8')).toBe('USER WORK IN PROGRESS\n');
    expect((await gitStatus(repo)).branch).toBe('main');
  });

  it('refuses a non-repo with a clear reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-git-norepo2-'));
    const r = await beginIsolation(dir, 'exp-3');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toContain('not a git repository'); }
  });
});

describe('acceptIsolation', () => {
  it('merges the accepted experiment into the base branch (fast-forward)', async () => {
    const r = await beginIsolation(repo, 'ok-1');
    if (!r.ok) { throw new Error('setup'); }
    writeFileSync(join(repo, 'app.js'), 'const x = 42;\n');
    writeFileSync(join(repo, 'new.js'), 'export {};\n');

    const fin = await acceptIsolation(repo, r.isolation, 'codeflare: accepted change');
    expect(fin.ok).toBe(true);
    const s = await gitStatus(repo);
    expect(s.branch).toBe('main');
    expect(s.dirty).toBe(false);
    expect(readFileSync(join(repo, 'app.js'), 'utf8')).toBe('const x = 42;\n');
    expect(existsSync(join(repo, 'new.js'))).toBe(true);
    expect(sh(repo, ['log', '--oneline'])).toContain('codeflare: accepted change');
    // The experiment branch is gone (merged).
    expect(sh(repo, ['branch'])).not.toContain(r.isolation.branch);
  });

  it('refuses to force-merge when the base moved, preserving the experiment branch', async () => {
    const r = await beginIsolation(repo, 'moved-1');
    if (!r.ok) { throw new Error('setup'); }
    // The experiment commits its change on its branch…
    writeFileSync(join(repo, 'exp.js'), 'exp\n');
    sh(repo, ['add', 'exp.js']);
    sh(repo, ['commit', '-m', 'experiment work']);
    // …while the base moves underneath it.
    sh(repo, ['checkout', 'main']);
    writeFileSync(join(repo, 'other.js'), 'other\n');
    sh(repo, ['add', 'other.js']);
    sh(repo, ['commit', '-m', 'user commit on base']);
    sh(repo, ['checkout', r.isolation.branch]);

    const fin = await acceptIsolation(repo, r.isolation, 'codeflare: accepted');
    expect(fin.ok).toBe(false);
    expect(fin.detail).toContain('not force-merging');
    // Base branch history is exactly the user's — no CodeFlare commit on it.
    expect(sh(repo, ['log', '--oneline', 'main'])).not.toContain('codeflare');
    expect(sh(repo, ['branch'])).toContain('moved-1');
  });
});

describe('rejectIsolation', () => {
  it('restores the known-good tree and preserves the rejected diff on the branch', async () => {
    const r = await beginIsolation(repo, 'rej-1');
    if (!r.ok) { throw new Error('setup'); }
    writeFileSync(join(repo, 'app.js'), 'BROKEN CANDIDATE\n');
    writeFileSync(join(repo, 'junk.js'), 'left behind?\n');

    const fin = await rejectIsolation(repo, r.isolation, 'codeflare: rejected experiment');
    expect(fin.ok).toBe(true);
    const s = await gitStatus(repo);
    // Known-good state is fully restored — content back, created file gone.
    expect(s.branch).toBe('main');
    expect(s.dirty).toBe(false);
    expect(readFileSync(join(repo, 'app.js'), 'utf8')).toBe('const x = 1;\n');
    expect(existsSync(join(repo, 'junk.js'))).toBe(false);
    // …and the base branch gained NO commit.
    expect(sh(repo, ['log', '--oneline', 'main']).trim().split('\n')).toHaveLength(1);
    // The rejected diff is inspectable on the preserved branch.
    expect(fin.detail).toContain(r.isolation.branch);
    const diff = sh(repo, ['diff', 'main..' + r.isolation.branch]);
    expect(diff).toContain('BROKEN CANDIDATE');
  });

  it('cleans up the branch when the experiment changed nothing', async () => {
    const r = await beginIsolation(repo, 'rej-2');
    if (!r.ok) { throw new Error('setup'); }
    const fin = await rejectIsolation(repo, r.isolation, 'codeflare: nothing');
    expect(fin.ok).toBe(true);
    expect(fin.detail).toContain('no changes');
    expect(sh(repo, ['branch'])).not.toContain('rej-2');
    expect((await gitStatus(repo)).branch).toBe('main');
  });
});

describe('parkIsolation (NEEDS_REVIEW)', () => {
  it('stays on the experiment branch with everything committed', async () => {
    const r = await beginIsolation(repo, 'park-1');
    if (!r.ok) { throw new Error('setup'); }
    writeFileSync(join(repo, 'app.js'), 'needs a human\n');
    const fin = await parkIsolation(repo, r.isolation, 'codeflare: needs review');
    expect(fin.ok).toBe(true);
    const s = await gitStatus(repo);
    expect(s.branch).toBe(r.isolation.branch);
    expect(s.dirty).toBe(false);   // committed, so checkout main restores known-good at any time
    expect(readFileSync(join(repo, 'app.js'), 'utf8')).toBe('needs a human\n');
  });
});
