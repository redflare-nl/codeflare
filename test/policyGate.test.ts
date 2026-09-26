import { afterEach, describe, expect, it } from 'vitest';
import {
  activeGuardrails, beginPolicyTurn, endPolicyTurn, gateCommand, gateMutation, previewMutation,
} from '../src/engine/policyGate';
import { DEFAULT_FORBIDDEN_PATHS, DEFAULT_PROTECTED_PATHS, GUARDRAIL_PATHS } from '../src/engine/policy';

/**
 * Guardrail locking at the turn gate — the first two of the three layers that
 * keep a self-improving run from loosening its own constraints. The third
 * (selfUpdate.prepare) is covered in selfUpdate.test.ts.
 */

const paths = () => ({ allowedPaths: [], protectedPaths: [...DEFAULT_PROTECTED_PATHS], forbiddenPaths: [...DEFAULT_FORBIDDEN_PATHS] });

afterEach(() => endPolicyTurn());

describe('policy gate — guardrails', () => {
  it('reports no guardrail mode when none was requested', () => {
    beginPolicyTurn({ profile: 'autonomous', paths: paths() });
    expect(activeGuardrails()).toBeUndefined();
    // Without guardrails, a guardrail file is an ordinary file (autonomous profile, not protected by default).
    expect(gateMutation('src/engine/policy.ts', { addedLines: 1 }).allowed).toBe(true);
  });

  it('"forbid" blocks every guardrail file via file tools, in every profile', () => {
    for (const profile of ['interactive', 'conservative-autonomous', 'autonomous'] as const) {
      beginPolicyTurn({ profile, paths: paths(), guardrails: 'forbid' });
      expect(activeGuardrails()).toBe('forbid');
      for (const file of GUARDRAIL_PATHS) {
        const v = gateMutation(file, { addedLines: 1 });
        expect(v.allowed, `${profile}: ${file}`).toBe(false);
        expect(v.code).toBe('PATH_FORBIDDEN');
        // Preflight (apply_patch phase 1, rename) must agree with the real gate.
        expect(previewMutation(file).allowed).toBe(false);
      }
      // Windows spelling and ./ prefix are not a way around it.
      expect(gateMutation('src\\engine\\policyGate.ts').allowed).toBe(false);
      expect(gateMutation('./src/engine/evidence.ts').allowed).toBe(false);
      // Ordinary source stays writable — the lock is narrow.
      expect(gateMutation('src/llm/prompts.ts', { addedLines: 1 }).allowed).toBe(true);
      endPolicyTurn();
    }
  });

  it('"protect" blocks guardrail files in autonomous profiles but leaves interactive to the confirm flow', () => {
    beginPolicyTurn({ profile: 'autonomous', paths: paths(), guardrails: 'protect' });
    const v = gateMutation('src/engine/selfUpdate.ts', { addedLines: 1 });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('PATH_PROTECTED');
    endPolicyTurn();

    beginPolicyTurn({ profile: 'interactive', paths: paths(), guardrails: 'protect' });
    expect(gateMutation('src/engine/selfUpdate.ts', { addedLines: 1 }).allowed).toBe(true);
  });

  it('does not mutate the caller\'s path policy object', () => {
    const p = paths();
    const before = { forbidden: p.forbiddenPaths.length, protected: p.protectedPaths.length };
    beginPolicyTurn({ profile: 'autonomous', paths: p, guardrails: 'forbid' });
    expect(p.forbiddenPaths).toHaveLength(before.forbidden);
    expect(p.protectedPaths).toHaveLength(before.protected);
  });

  describe('command gate under "forbid"', () => {
    it('refuses shell writes that name a guardrail file, including via the shell', () => {
      beginPolicyTurn({ profile: 'interactive', paths: paths(), guardrails: 'forbid' });
      for (const cmd of [
        'echo "x" > src/engine/policy.ts',
        'Set-Content src\\engine\\policyGate.ts "y"',
        'sed -i "s/a/b/" src/engine/evidence.ts',
        'cat src/engine/policy.ts && echo patched > src/engine/policy.ts',
        'cp /tmp/x scripts/self-update-recovery.cjs',
        'node -e "require(\'fs\').writeFileSync(\'src/engine/experiment.ts\', \'\')"',
      ]) {
        const v = gateCommand(cmd);
        expect(v.allowed, cmd).toBe(false);
        expect(v.code).toBe('PATH_FORBIDDEN');
      }
    });

    it('still allows plainly reading a guardrail file — the model must be able to inspect them', () => {
      beginPolicyTurn({ profile: 'interactive', paths: paths(), guardrails: 'forbid' });
      for (const cmd of [
        'cat src/engine/policy.ts',
        'type src\\engine\\policyGate.ts',
        'grep -n "GUARDRAIL" src/engine/policy.ts',
        'git diff HEAD -- src/engine/evidence.ts',
        'git show HEAD:src/engine/selfUpdate.ts',
        'head -40 src/engine/policy.ts | grep export',
        'Get-Content src/engine/agentScope.ts',
      ]) {
        expect(gateCommand(cmd).allowed, cmd).toBe(true);
      }
    });

    it('refuses git operations that move HEAD, even when no guardrail file is named', () => {
      beginPolicyTurn({ profile: 'interactive', paths: paths(), guardrails: 'forbid' });
      for (const cmd of ['git commit -m "tweak"', 'git add -A', 'git apply fix.patch', 'git checkout -- .', 'git reset --hard', 'git stash']) {
        const v = gateCommand(cmd);
        expect(v.allowed, cmd).toBe(false);
        expect(v.code).toBe('COMMAND_BLOCKED');
      }
      // Read-only git is fine.
      expect(gateCommand('git status').allowed).toBe(true);
      expect(gateCommand('git log --oneline -5').allowed).toBe(true);
    });

    it('does not touch unrelated commands', () => {
      beginPolicyTurn({ profile: 'interactive', paths: paths(), guardrails: 'forbid' });
      expect(gateCommand('npm test').allowed).toBe(true);
      expect(gateCommand('npx tsc --noEmit').allowed).toBe(true);
      expect(gateCommand('echo hi > notes.txt').allowed).toBe(true);
    });

    it('applies only in "forbid" — "protect" leaves commands to the profile rules', () => {
      beginPolicyTurn({ profile: 'interactive', paths: paths(), guardrails: 'protect' });
      expect(gateCommand('git commit -m "x"').allowed).toBe(true);
      expect(gateCommand('echo x > src/engine/policy.ts').allowed).toBe(true);
    });
  });
});
