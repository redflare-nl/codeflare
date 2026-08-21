/**
 * Git experiment isolation — autonomous changes happen on a dedicated branch,
 * never directly on the user's known-good branch.
 *
 *   KNOWN GOOD ──► codeflare/exp-<id> ──► agent edits ──► verify
 *                                                          ├─ ACCEPT → merge back (ff-only), delete branch
 *                                                          ├─ REJECT → commit on branch, switch back — tree
 *                                                          │           restored to known-good, diff kept
 *                                                          └─ REVIEW → stay on branch, changes committed
 *
 * Safety rules (enforced, not advisory):
 *  - a DIRTY working tree is never touched — isolation refuses and reports
 *    weaker (checkpoint-only) isolation instead; no stash, no reset, ever;
 *  - nothing is ever pushed, no remote is ever contacted;
 *  - the base branch is only moved by a fast-forward merge of the verified
 *    experiment — if the base moved meanwhile, the merge is refused and the
 *    experiment branch is left for manual review.
 *
 * No vscode imports — plain git CLI against a cwd, so the whole lifecycle is
 * unit-tested against real temporary repositories.
 */

import { execFile } from 'child_process';

const GIT_TIMEOUT_MS = 15_000;

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; missing?: boolean }> {
  return new Promise(resolve => {
    execFile('git',
      ['-c', 'user.name=CodeFlare', '-c', 'user.email=codeflare@local', ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ ok: false, out: 'git is not installed', missing: true });
          return;
        }
        resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim() });
      });
  });
}

export interface GitStatus {
  gitAvailable: boolean;
  isRepo: boolean;
  branch?: string;
  detached?: boolean;
  headCommit?: string;
  dirty: boolean;
  dirtyFiles: string[];
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const branchRes = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchRes.missing) {
    return { gitAvailable: false, isRepo: false, dirty: false, dirtyFiles: [] };
  }
  if (!branchRes.ok) {
    // Not a repo, or a repo with no commits — either way not isolatable.
    return { gitAvailable: true, isRepo: false, dirty: false, dirtyFiles: [] };
  }
  const branch = branchRes.out;
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  const status = await git(cwd, ['status', '--porcelain']);
  // Porcelain rows are "XY path"; git() trims the combined output, which can
  // eat the first row's leading status space — strip the status column by
  // pattern, not by fixed offset.
  const dirtyFiles = status.ok && status.out
    ? status.out.split('\n')
        .map(l => l.replace(/^\s*\S{1,2}\s+/, '').trim())
        .filter(Boolean)
    : [];
  return {
    gitAvailable: true,
    isRepo: true,
    branch,
    detached: branch === 'HEAD',
    headCommit: head.ok ? head.out : undefined,
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
  };
}

export interface Isolation {
  branch: string;
  baseBranch: string;
  baseCommit: string;
}

export type BeginResult =
  | { ok: true; isolation: Isolation }
  | { ok: false; reason: string };

/** Start an isolated experiment branch. Refuses rather than risking user work. */
export async function beginIsolation(cwd: string, id: string): Promise<BeginResult> {
  const s = await gitStatus(cwd);
  if (!s.gitAvailable) { return { ok: false, reason: 'git is not installed' }; }
  if (!s.isRepo) { return { ok: false, reason: 'not a git repository (or no commits yet)' }; }
  if (s.detached) { return { ok: false, reason: 'detached HEAD — check out a branch first' }; }
  if (!s.headCommit) { return { ok: false, reason: 'repository has no commits yet' }; }
  if (s.dirty) {
    return {
      ok: false,
      reason: `working tree has ${s.dirtyFiles.length} uncommitted change(s) — CodeFlare never ` +
        `stashes or resets user work. Commit or stash them yourself for isolated experiments.`,
    };
  }
  const branch = `codeflare/exp-${id.replace(/[^a-zA-Z0-9._-]+/g, '-')}`;
  const res = await git(cwd, ['checkout', '-b', branch]);
  if (!res.ok) { return { ok: false, reason: `could not create the experiment branch: ${res.out}` }; }
  return { ok: true, isolation: { branch, baseBranch: s.branch!, baseCommit: s.headCommit } };
}

/** Commit everything on the experiment branch. Returns false when there was nothing to commit. */
async function commitAll(cwd: string, message: string): Promise<{ committed: boolean; error?: string }> {
  const add = await git(cwd, ['add', '-A']);
  if (!add.ok) { return { committed: false, error: add.out }; }
  const staged = await git(cwd, ['status', '--porcelain']);
  if (!staged.out) { return { committed: false }; }
  const commit = await git(cwd, ['commit', '-m', message]);
  if (!commit.ok) { return { committed: false, error: commit.out }; }
  return { committed: true };
}

/**
 * Whether the experiment produced anything at all: commits beyond its base
 * (the model may have committed on the branch itself) — an uncommitted-only
 * tree has just been swept up by commitAll before this is called.
 */
async function branchAhead(cwd: string, baseCommit: string): Promise<boolean> {
  const res = await git(cwd, ['rev-list', '--count', `${baseCommit}..HEAD`]);
  return res.ok && parseInt(res.out, 10) > 0;
}

export interface FinishResult { ok: boolean; detail: string; }

/**
 * ACCEPT: commit the experiment, return to the base branch, fast-forward it.
 * If the base moved during the experiment the merge is refused and the branch
 * is preserved for manual review — the base is never force-moved.
 */
export async function acceptIsolation(cwd: string, iso: Isolation, message: string): Promise<FinishResult> {
  const c = await commitAll(cwd, message);
  if (c.error) { return { ok: false, detail: `could not commit the experiment: ${c.error}` }; }
  const hasWork = c.committed || await branchAhead(cwd, iso.baseCommit);
  const back = await git(cwd, ['checkout', iso.baseBranch]);
  if (!back.ok) { return { ok: false, detail: `could not return to ${iso.baseBranch}: ${back.out}` }; }
  if (!hasWork) {
    await git(cwd, ['branch', '-D', iso.branch]);
    return { ok: true, detail: 'no changes to merge — experiment branch removed' };
  }
  const merge = await git(cwd, ['merge', '--ff-only', iso.branch]);
  if (!merge.ok) {
    return {
      ok: false,
      detail: `${iso.baseBranch} moved during the experiment — not force-merging. The accepted ` +
        `change is preserved on ${iso.branch}; merge it manually.`,
    };
  }
  await git(cwd, ['branch', '-D', iso.branch]);
  return { ok: true, detail: `merged into ${iso.baseBranch} (fast-forward) as one commit` };
}

/**
 * REJECT: preserve the diff as a commit on the experiment branch, then return
 * to the base branch — the working tree goes back to known-good.
 */
export async function rejectIsolation(cwd: string, iso: Isolation, message: string): Promise<FinishResult> {
  const c = await commitAll(cwd, message);
  if (c.error) { return { ok: false, detail: `could not preserve the rejected diff: ${c.error}` }; }
  const hasWork = c.committed || await branchAhead(cwd, iso.baseCommit);
  const back = await git(cwd, ['checkout', iso.baseBranch]);
  if (!back.ok) { return { ok: false, detail: `could not return to ${iso.baseBranch}: ${back.out}` }; }
  if (!hasWork) {
    await git(cwd, ['branch', '-D', iso.branch]);
    return { ok: true, detail: 'no changes were made — experiment branch removed' };
  }
  return {
    ok: true,
    detail: `known-good tree restored; the rejected diff is preserved on ${iso.branch} ` +
      `(inspect with: git diff ${iso.baseBranch}..${iso.branch})`,
  };
}

/**
 * NEEDS_REVIEW / INCONCLUSIVE: keep the working tree ON the experiment branch
 * (so the user can look at the real files), with everything committed so a
 * plain checkout of the base restores known-good at any time.
 */
export async function parkIsolation(cwd: string, iso: Isolation, message: string): Promise<FinishResult> {
  const c = await commitAll(cwd, message);
  if (c.error) { return { ok: false, detail: `could not commit the experiment state: ${c.error}` }; }
  if (!c.committed && !(await branchAhead(cwd, iso.baseCommit))) {
    await git(cwd, ['checkout', iso.baseBranch]);
    await git(cwd, ['branch', '-D', iso.branch]);
    return { ok: true, detail: 'no changes were made — experiment branch removed' };
  }
  return {
    ok: true,
    detail: `left on ${iso.branch} for review (committed). Merge it into ${iso.baseBranch} to keep, ` +
      `or "git checkout ${iso.baseBranch}" to go back to known-good.`,
  };
}
