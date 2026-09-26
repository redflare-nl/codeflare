import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUDGET_PROFILES,
  DEFAULT_FORBIDDEN_PATHS,
  DEFAULT_PROTECTED_PATHS,
  GUARDRAIL_PATHS,
  checkCommand,
  checkGuardrailCommand,
  checkPath,
  isGuardrailPath,
  matchGlob,
} from '../src/engine/policy';
import {
  beginPolicyTurn,
  endPolicyTurn,
  gateCommand,
  gateMutation,
  gateToolCall,
  previewMutation,
  canPrompt,
} from '../src/engine/policyGate';

const PATHS = {
  allowedPaths: [] as string[],
  protectedPaths: DEFAULT_PROTECTED_PATHS,
  forbiddenPaths: DEFAULT_FORBIDDEN_PATHS,
};

describe('guardrails (pure)', () => {
  it('names the files that constitute the safety boundary, and nothing outside src/engine + scripts', () => {
    expect(GUARDRAIL_PATHS).toContain('src/engine/policy.ts');
    expect(GUARDRAIL_PATHS).toContain('src/engine/policyGate.ts');
    expect(GUARDRAIL_PATHS).toContain('src/engine/selfUpdate.ts');
    expect(GUARDRAIL_PATHS).toContain('scripts/self-update-recovery.cjs');
    for (const p of GUARDRAIL_PATHS) { expect(p).toMatch(/^(src\/engine\/|scripts\/)/); }
    // The normal improvement surface is deliberately NOT locked.
    expect(GUARDRAIL_PATHS).not.toContain('src/llm/tools.ts');
    expect(GUARDRAIL_PATHS).not.toContain('src/utils/config.ts');
  });

  it('isGuardrailPath tolerates spelling variants and rejects near-misses', () => {
    expect(isGuardrailPath('src/engine/policy.ts')).toBe(true);
    expect(isGuardrailPath('src\\engine\\policy.ts')).toBe(true);
    expect(isGuardrailPath('./src/engine/POLICY.TS')).toBe(true);
    expect(isGuardrailPath('test/policy.test.ts')).toBe(false);
    expect(isGuardrailPath('src/engine/policyGate.test.ts')).toBe(false);
    expect(isGuardrailPath('')).toBe(false);
  });

  it('guardrail files appended as forbidden are blocked in every profile, as protected only autonomously', () => {
    const forbid = { ...PATHS, forbiddenPaths: [...PATHS.forbiddenPaths, ...GUARDRAIL_PATHS] };
    const protect = { ...PATHS, protectedPaths: [...PATHS.protectedPaths, ...GUARDRAIL_PATHS] };
    for (const profile of ['interactive', 'conservative-autonomous', 'autonomous'] as const) {
      expect(checkPath('src/engine/policy.ts', forbid, profile).code).toBe('PATH_FORBIDDEN');
    }
    expect(checkPath('src/engine/policy.ts', protect, 'autonomous').code).toBe('PATH_PROTECTED');
    expect(checkPath('src/engine/policy.ts', protect, 'interactive').allowed).toBe(true);
  });

  describe('checkGuardrailCommand', () => {
    it('refuses writes, allows reads, and judges every segment of a chain', () => {
      expect(checkGuardrailCommand('echo x > src/engine/policy.ts').allowed).toBe(false);
      expect(checkGuardrailCommand('cat src/engine/policy.ts').allowed).toBe(true);
      expect(checkGuardrailCommand('cat src/engine/policy.ts; echo y >> src/engine/policy.ts').allowed).toBe(false);
      expect(checkGuardrailCommand('grep -n export src/engine/policy.ts | head -5').allowed).toBe(true);
    });

    it('matches by basename too, so a cd or relative spelling cannot dodge it', () => {
      expect(checkGuardrailCommand('cd src/engine && echo x > policy.ts').allowed).toBe(false);
      expect(checkGuardrailCommand('cd src/engine && cat policy.ts').allowed).toBe(true);
    });

    it('treats output redirection as a write even after a read-only leader', () => {
      expect(checkGuardrailCommand('cat other.ts > src/engine/evidence.ts').allowed).toBe(false);
      // Input redirection is not a write.
      expect(checkGuardrailCommand('grep export < src/engine/evidence.ts').allowed).toBe(true);
    });

    it('blocks HEAD-moving git regardless of the paths mentioned', () => {
      expect(checkGuardrailCommand('git commit -am "loosen budgets"').code).toBe('COMMAND_BLOCKED');
      expect(checkGuardrailCommand('git add src/llm/prompts.ts').code).toBe('COMMAND_BLOCKED');
      expect(checkGuardrailCommand('git diff').allowed).toBe(true);
      expect(checkGuardrailCommand('git show HEAD:src/engine/policy.ts').allowed).toBe(true);
    });

    it('leaves commands that do not involve guardrails alone', () => {
      expect(checkGuardrailCommand('').allowed).toBe(true);
      expect(checkGuardrailCommand('npm run build').allowed).toBe(true);
      expect(checkGuardrailCommand('echo done > out/log.txt').allowed).toBe(true);
    });
  });
});

describe('matchGlob', () => {
  it('matches ** across directories and * within a segment', () => {
    expect(matchGlob('src/a/b/c.ts', 'src/**')).toBe(true);
    expect(matchGlob('src/a.ts', 'src/*.ts')).toBe(true);
    expect(matchGlob('src/a/b.ts', 'src/*.ts')).toBe(false);
  });

  it('matches slash-free patterns by basename at any depth', () => {
    expect(matchGlob('sub/module/package.json', 'package.json')).toBe(true);
    expect(matchGlob('a/b/.env.local', '.env*')).toBe(true);
  });

  it('normalizes backslashes and ./ prefixes (no bypass via path spelling)', () => {
    expect(matchGlob('.github\\workflows\\ci.yml', '.github/**')).toBe(true);
    expect(matchGlob('./.github/workflows/ci.yml', '.github/**')).toBe(true);
    expect(matchGlob('.GitHub/Workflows/CI.yml', '.github/**')).toBe(true); // case-insensitive (Windows)
  });

  it('matches the bare directory itself for dir/** patterns', () => {
    expect(matchGlob('.github', '.github/**')).toBe(true);
  });
});

describe('checkPath', () => {
  it('forbidden paths are blocked in EVERY profile, interactive included', () => {
    for (const profile of ['interactive', 'conservative-autonomous', 'autonomous'] as const) {
      const v = checkPath('.codeflare/memory.md', PATHS, profile);
      expect(v.allowed).toBe(false);
      expect(v.code).toBe('PATH_FORBIDDEN');
    }
    expect(checkPath('.git/hooks/pre-commit', PATHS, 'autonomous').allowed).toBe(false);
    expect(checkPath('home/.ssh/config', PATHS, 'interactive').allowed).toBe(false);
  });

  it('credential-ish names are protected (autonomous-blocked) but do not degrade interactive work', () => {
    expect(checkPath('config/credentials.json', PATHS, 'autonomous').allowed).toBe(false);
    expect(checkPath('src/secretSanta.ts', PATHS, 'autonomous').allowed).toBe(false);
    // Interactive mode keeps its existing confirm flow for these.
    expect(checkPath('config/credentials.json', PATHS, 'interactive').allowed).toBe(true);
    expect(checkPath('src/secretSanta.ts', PATHS, 'interactive').allowed).toBe(true);
  });

  it('protected paths pass in interactive mode (existing confirm flow) but are blocked autonomously', () => {
    expect(checkPath('package.json', PATHS, 'interactive').allowed).toBe(true);
    const v = checkPath('package.json', PATHS, 'autonomous');
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('PATH_PROTECTED');
    expect(checkPath('.github/workflows/ci.yml', PATHS, 'conservative-autonomous').allowed).toBe(false);
    expect(checkPath('.env.production', PATHS, 'autonomous').allowed).toBe(false);
  });

  it('allowedPaths restricts autonomous mutations but never interactive ones', () => {
    const paths = { ...PATHS, allowedPaths: ['src/**', 'tests/**'] };
    expect(checkPath('docs/readme.md', paths, 'interactive').allowed).toBe(true);
    expect(checkPath('src/app.ts', paths, 'autonomous').allowed).toBe(true);
    const v = checkPath('docs/readme.md', paths, 'autonomous');
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('PATH_NOT_ALLOWED');
  });
});

describe('checkCommand', () => {
  it('interactive mode blocks nothing here (the confirm flow handles it)', () => {
    expect(checkCommand('git push origin main', 'interactive').allowed).toBe(true);
  });

  it('autonomous profiles refuse publish/deploy/push/history-rewrite/installs', () => {
    for (const cmd of [
      'git push origin main',
      'git push --force',
      'npm publish',
      'git reset --hard HEAD~3',
      'git rebase -i main',
      'docker push myimage',
      'kubectl apply -f prod.yml',
      'npm install left-pad',
      'pip install requests',
      'aws s3 sync . s3://bucket',
    ]) {
      const v = checkCommand(cmd, 'autonomous');
      expect(v.allowed, cmd).toBe(false);
      expect(v.code).toBe('COMMAND_BLOCKED');
    }
  });

  it('ordinary build/test commands stay allowed autonomously', () => {
    for (const cmd of ['npm test', 'npm run build', 'npx tsc --noEmit', 'pytest -q', 'git status', 'git diff']) {
      expect(checkCommand(cmd, 'autonomous').allowed, cmd).toBe(true);
    }
  });
});

describe('policyGate (turn-scoped enforcement)', () => {
  beforeEach(() => endPolicyTurn());

  it('is wide open when not armed (outside a turn)', () => {
    expect(gateMutation('package.json').allowed).toBe(true);
    expect(gateToolCall().allowed).toBe(true);
    expect(gateCommand('git push').allowed).toBe(true);
    expect(canPrompt()).toBe(true);
  });

  it('interactive profile keeps today\'s behaviour except forbidden paths', () => {
    beginPolicyTurn({ profile: 'interactive', paths: PATHS });
    expect(gateMutation('src/a.ts', { addedLines: 100000 }).allowed).toBe(true); // no budget
    expect(gateMutation('package.json').allowed).toBe(true);                     // confirm flow handles it
    expect(gateMutation('secrets.yaml').allowed).toBe(true);                     // protected → confirm flow
    expect(gateMutation('.codeflare/memory.md').allowed).toBe(false);            // forbidden everywhere
    expect(canPrompt()).toBe(true);
  });

  it('stops at maxChangedFiles and refuses everything after (budget cannot be re-negotiated)', () => {
    beginPolicyTurn({
      profile: 'conservative-autonomous',
      paths: PATHS,
      budgetOverrides: { maxChangedFiles: 2 },
    });
    expect(gateMutation('src/a.ts').allowed).toBe(true);
    expect(gateMutation('src/a.ts').allowed).toBe(true);   // same file — not a new one
    expect(gateMutation('src/b.ts').allowed).toBe(true);
    const v = gateMutation('src/c.ts');
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('CHANGE_BUDGET_EXCEEDED');
    // Tripped: even a previously-fine file is now refused.
    expect(gateMutation('src/a.ts').allowed).toBe(false);
    expect(gateToolCall().allowed).toBe(false);
  });

  it('stops at maxAddedLines', () => {
    beginPolicyTurn({
      profile: 'autonomous',
      paths: PATHS,
      budgetOverrides: { maxAddedLines: 100 },
    });
    expect(gateMutation('src/a.ts', { addedLines: 80 }).allowed).toBe(true);
    const v = gateMutation('src/b.ts', { addedLines: 40 });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('CHANGE_BUDGET_EXCEEDED');
  });

  it('stops at maxToolCalls', () => {
    beginPolicyTurn({
      profile: 'autonomous',
      paths: PATHS,
      budgetOverrides: { maxToolCalls: 3 },
    });
    expect(gateToolCall().allowed).toBe(true);
    expect(gateToolCall().allowed).toBe(true);
    expect(gateToolCall().allowed).toBe(true);
    expect(gateToolCall().allowed).toBe(false);
  });

  it('previewMutation checks without consuming the budget (atomic validation passes)', () => {
    beginPolicyTurn({
      profile: 'autonomous',
      paths: PATHS,
      budgetOverrides: { maxChangedFiles: 1 },
    });
    expect(previewMutation('src/a.ts').allowed).toBe(true);
    expect(previewMutation('src/b.ts').allowed).toBe(true); // still 0 recorded
    expect(previewMutation('package.json').allowed).toBe(false);
    expect(gateMutation('src/a.ts').allowed).toBe(true);    // 1 recorded
    expect(previewMutation('src/b.ts').allowed).toBe(false); // would be file #2
  });

  it('cannot be bypassed through path spelling in tool arguments', () => {
    beginPolicyTurn({ profile: 'autonomous', paths: PATHS });
    expect(gateMutation('package.json').allowed).toBe(false);
    expect(gateMutation('.\\package.json').allowed).toBe(false);
    expect(gateMutation('sub\\dir\\package.json').allowed).toBe(false);
    expect(gateMutation('.GitHub\\workflows\\x.yml').allowed).toBe(false);
  });

  it('autonomous profiles cannot prompt', () => {
    beginPolicyTurn({ profile: 'autonomous', paths: PATHS });
    expect(canPrompt()).toBe(false);
  });

  it('endPolicyTurn disarms enforcement', () => {
    beginPolicyTurn({ profile: 'autonomous', paths: PATHS });
    expect(gateMutation('package.json').allowed).toBe(false);
    endPolicyTurn();
    expect(gateMutation('package.json').allowed).toBe(true);
  });

  it('profiles ship with sane budget defaults', () => {
    expect(BUDGET_PROFILES['interactive'].maxChangedFiles).toBe(0);          // unlimited
    expect(BUDGET_PROFILES['conservative-autonomous'].maxChangedFiles).toBeGreaterThan(0);
    expect(BUDGET_PROFILES['autonomous'].maxChangedFiles)
      .toBeGreaterThan(BUDGET_PROFILES['conservative-autonomous'].maxChangedFiles);
  });
});
