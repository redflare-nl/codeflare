/**
 * Deterministic policy: hard change budgets and path rules. Prompt
 * instructions are not a security boundary — these verdicts are enforced at
 * tool-execution level and the model cannot negotiate with them.
 *
 * Profiles:
 *  - interactive            — today's behaviour: no budgets, protected paths
 *                             fall back to the existing confirmation flow.
 *  - conservative-autonomous — tight budgets, protected paths blocked.
 *  - autonomous             — wider budgets, protected paths still blocked.
 *
 * Pure module (no vscode imports) so it is unit-testable.
 */

export type AutonomyProfile = 'interactive' | 'conservative-autonomous' | 'autonomous';

export interface ChangeBudget {
  /** 0 = unlimited. */
  maxChangedFiles: number;
  maxNewFiles: number;
  maxAddedLines: number;
  maxDeletedLines: number;
  maxToolCalls: number;
  maxWallTimeMs: number;
}

export interface PathPolicy {
  /** Non-empty ⇒ (non-interactive) mutations must match one of these. */
  allowedPaths: string[];
  /** Sensitive infrastructure: blocked in autonomous profiles; interactive keeps its confirm flow. */
  protectedPaths: string[];
  /** Never writable by the agent, in any profile. */
  forbiddenPaths: string[];
}

export type PolicyCode =
  | 'CHANGE_BUDGET_EXCEEDED'
  | 'PATH_FORBIDDEN'
  | 'PATH_PROTECTED'
  | 'PATH_NOT_ALLOWED'
  | 'COMMAND_BLOCKED';

export interface PolicyVerdict {
  allowed: boolean;
  code?: PolicyCode;
  reason?: string;
}

const OK: PolicyVerdict = { allowed: true };

export const BUDGET_PROFILES: Record<AutonomyProfile, ChangeBudget> = {
  // 0 = unlimited: interactive mode keeps exactly today's behaviour.
  'interactive': {
    maxChangedFiles: 0, maxNewFiles: 0, maxAddedLines: 0, maxDeletedLines: 0,
    maxToolCalls: 0, maxWallTimeMs: 0,
  },
  'conservative-autonomous': {
    maxChangedFiles: 3, maxNewFiles: 2, maxAddedLines: 250, maxDeletedLines: 150,
    maxToolCalls: 80, maxWallTimeMs: 15 * 60_000,
  },
  'autonomous': {
    maxChangedFiles: 8, maxNewFiles: 5, maxAddedLines: 800, maxDeletedLines: 400,
    maxToolCalls: 200, maxWallTimeMs: 30 * 60_000,
  },
};

/** Sensitive infrastructure no unattended agent should touch silently. */
export const DEFAULT_PROTECTED_PATHS = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'go.mod',
  '.github/**', '.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile',
  'deployment/**', 'deploy/**', 'Dockerfile*', 'docker-compose*',
  '.env*', '*.pem', '*.key', '**/credentials*', '**/*secret*',
];

/**
 * Never writable, any profile: SSH keys, git internals, and CodeFlare's own
 * records (metrics/experiments/memory must not be editable by the agent whose
 * work they judge). Kept narrow — broad name heuristics live in PROTECTED so
 * interactive work on e.g. "secretSanta.ts" is not degraded.
 */
export const DEFAULT_FORBIDDEN_PATHS = [
  '**/.ssh/**', '**/id_rsa*',
  '.git/**', '.codeflare/**',
];

/**
 * Minimal glob matcher: `**` crosses directories, `*` within a segment, `?`
 * one char. Case-insensitive (Windows). Paths are compared with forward
 * slashes; a pattern without a slash also matches by basename (so
 * `package.json` covers `sub/module/package.json`).
 */
export function matchGlob(relPath: string, pattern: string): boolean {
  const path = relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const toRe = (pat: string): RegExp => {
    let re = '';
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i];
      if (c === '/' && pat[i + 1] === '*' && pat[i + 2] === '*') {
        // `/**` — the bare directory itself, or anything beneath it.
        re += '(?:/.*)?';
        i += 2;
        if (pat[i + 1] === '/') { i++; }   // the separator is part of the match-all
      } else if (c === '*') {
        if (pat[i + 1] === '*') {
          re += '.*';
          i++;
          if (pat[i + 1] === '/') { i++; re += '/?'; }   // leading `**/` may match nothing
        } else {
          re += '[^/]*';
        }
      } else if (c === '?') { re += '[^/]'; }
      else { re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&'); }
    }
    return new RegExp(`^${re}$`, 'i');
  };
  const pat = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (toRe(pat).test(path)) { return true; }
  // Basename convenience: a slash-free pattern matches at any depth.
  if (!pat.includes('/')) {
    const base = path.split('/').pop() || '';
    return toRe(pat).test(base);
  }
  return false;
}

export interface TurnTotals {
  changedFiles: Set<string>;
  newFiles: Set<string>;
  addedLines: number;
  deletedLines: number;
  toolCalls: number;
  startedAt: number;
}

export function newTurnTotals(now = Date.now()): TurnTotals {
  return { changedFiles: new Set(), newFiles: new Set(), addedLines: 0, deletedLines: 0, toolCalls: 0, startedAt: now };
}

/** Path rules for one mutation. Forbidden always wins; the rest depend on profile. */
export function checkPath(relPath: string, policy: PathPolicy, profile: AutonomyProfile): PolicyVerdict {
  const p = relPath.replace(/\\/g, '/');
  for (const pat of policy.forbiddenPaths) {
    if (matchGlob(p, pat)) {
      return { allowed: false, code: 'PATH_FORBIDDEN', reason: `"${p}" matches forbidden path "${pat}"` };
    }
  }
  if (profile === 'interactive') { return OK; }   // protected/allowed use the existing confirm flow
  for (const pat of policy.protectedPaths) {
    if (matchGlob(p, pat)) {
      return {
        allowed: false, code: 'PATH_PROTECTED',
        reason: `"${p}" matches protected path "${pat}" — not modifiable in ${profile} mode`,
      };
    }
  }
  if (policy.allowedPaths.length > 0 && !policy.allowedPaths.some(pat => matchGlob(p, pat))) {
    return {
      allowed: false, code: 'PATH_NOT_ALLOWED',
      reason: `"${p}" is outside the allowed paths (${policy.allowedPaths.join(', ')})`,
    };
  }
  return OK;
}

/**
 * Budget check for one mutation about to happen. `isNew` marks a file
 * creation; added/deleted are the mutation's approximate line delta.
 */
export function checkBudget(
  relPath: string,
  totals: TurnTotals,
  budget: ChangeBudget,
  delta: { isNew?: boolean; addedLines?: number; deletedLines?: number },
  now = Date.now()
): PolicyVerdict {
  const p = relPath.replace(/\\/g, '/');
  const over = (what: string, used: number | string, max: number): PolicyVerdict => ({
    allowed: false, code: 'CHANGE_BUDGET_EXCEEDED',
    reason: `${what}: ${used} would exceed the budget of ${max}`,
  });

  const files = totals.changedFiles.has(p) ? totals.changedFiles.size : totals.changedFiles.size + 1;
  if (budget.maxChangedFiles > 0 && files > budget.maxChangedFiles) {
    return over('changed files', files, budget.maxChangedFiles);
  }
  if (delta.isNew) {
    const news = totals.newFiles.has(p) ? totals.newFiles.size : totals.newFiles.size + 1;
    if (budget.maxNewFiles > 0 && news > budget.maxNewFiles) {
      return over('new files', news, budget.maxNewFiles);
    }
  }
  if (budget.maxAddedLines > 0 && totals.addedLines + (delta.addedLines || 0) > budget.maxAddedLines) {
    return over('added lines', totals.addedLines + (delta.addedLines || 0), budget.maxAddedLines);
  }
  if (budget.maxDeletedLines > 0 && totals.deletedLines + (delta.deletedLines || 0) > budget.maxDeletedLines) {
    return over('deleted lines', totals.deletedLines + (delta.deletedLines || 0), budget.maxDeletedLines);
  }
  if (budget.maxWallTimeMs > 0 && now - totals.startedAt > budget.maxWallTimeMs) {
    return over('wall time', `${Math.round((now - totals.startedAt) / 1000)}s`, Math.round(budget.maxWallTimeMs / 1000));
  }
  return OK;
}

/** Record a permitted mutation into the running totals. */
export function noteMutation(
  totals: TurnTotals,
  relPath: string,
  delta: { isNew?: boolean; addedLines?: number; deletedLines?: number }
): void {
  const p = relPath.replace(/\\/g, '/');
  totals.changedFiles.add(p);
  if (delta.isNew) { totals.newFiles.add(p); }
  totals.addedLines += Math.max(0, delta.addedLines || 0);
  totals.deletedLines += Math.max(0, delta.deletedLines || 0);
}

/** Tool-call budget: called once per tool invocation. */
export function checkToolCall(totals: TurnTotals, budget: ChangeBudget, now = Date.now()): PolicyVerdict {
  totals.toolCalls++;
  if (budget.maxToolCalls > 0 && totals.toolCalls > budget.maxToolCalls) {
    return {
      allowed: false, code: 'CHANGE_BUDGET_EXCEEDED',
      reason: `tool calls: ${totals.toolCalls} would exceed the budget of ${budget.maxToolCalls}`,
    };
  }
  if (budget.maxWallTimeMs > 0 && now - totals.startedAt > budget.maxWallTimeMs) {
    return {
      allowed: false, code: 'CHANGE_BUDGET_EXCEEDED',
      reason: `wall time: ${Math.round((now - totals.startedAt) / 1000)}s exceeds the budget of ${Math.round(budget.maxWallTimeMs / 1000)}s`,
    };
  }
  return OK;
}

/**
 * Commands no unattended agent may run, even when the interactive trust list
 * would allow them: anything that publishes, deploys, pushes, rewrites git
 * history, or installs arbitrary dependencies. Interactive mode keeps its
 * confirm-prompt flow instead.
 */
const AUTONOMOUS_BLOCKED_CMD_RE =
  /\bgit\s+push\b|\bgit\s+reset\s+--hard\b|\bgit\s+checkout\b[^\n]*\s--\s|\bgit\s+clean\b|\bgit\s+merge\b|\bgit\s+rebase\b|\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b|\btwine\b|\bcargo\s+publish\b|\bgem\s+push\b|\bdocker\s+push\b|\bkubectl\b|\bterraform\b|\bvercel\b|\bnetlify\b|\bfirebase\s+deploy\b|\baws\s|\bgcloud\s|\baz\s+\w|\b(npm|pnpm|yarn)\s+(install|add|i)\b\s+\S|\bpip3?\s+install\b|\bcargo\s+add\b|\bgo\s+get\b/i;

export function checkCommand(command: string, profile: AutonomyProfile): PolicyVerdict {
  if (profile === 'interactive') { return OK; }
  if (AUTONOMOUS_BLOCKED_CMD_RE.test(command || '')) {
    return {
      allowed: false, code: 'COMMAND_BLOCKED',
      reason: `this command is not permitted in ${profile} mode (publish/deploy/push/history-rewrite/dependency-install)`,
    };
  }
  return OK;
}

/** Render a verdict as the tool-result string the model receives. */
export function policyMessage(v: PolicyVerdict): string {
  return `POLICY ${v.code}: ${v.reason}. This limit is enforced by the runtime and cannot be ` +
    `negotiated. Stop this line of work and report the state honestly.`;
}
