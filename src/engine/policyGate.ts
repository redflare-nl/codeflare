/**
 * Turn-scoped policy enforcement state. The chat provider arms the gate at
 * turn start (same pattern as the checkpoint recorder); every mutating tool
 * and run_command consults it BEFORE acting. When the gate is not armed
 * (activation, stray calls outside a turn) everything is allowed — policy is
 * a property of a turn, not of the process.
 *
 * No vscode imports — configuration values are passed in by the provider.
 */

import {
  AutonomyProfile,
  BUDGET_PROFILES,
  ChangeBudget,
  PathPolicy,
  PolicyVerdict,
  TurnTotals,
  checkBudget,
  checkCommand,
  checkPath,
  checkToolCall,
  newTurnTotals,
  noteMutation,
} from './policy';

interface ActiveGate {
  profile: AutonomyProfile;
  budget: ChangeBudget;
  paths: PathPolicy;
  totals: TurnTotals;
  /** Set once a budget verdict failed — everything after is refused fast. */
  tripped?: PolicyVerdict;
}

let gate: ActiveGate | undefined;

export interface PolicyTurnConfig {
  profile: AutonomyProfile;
  paths: PathPolicy;
  /** Optional per-field overrides on the profile's budget (0 = unlimited). */
  budgetOverrides?: Partial<ChangeBudget>;
}

export function beginPolicyTurn(cfg: PolicyTurnConfig): void {
  gate = {
    profile: cfg.profile,
    budget: { ...BUDGET_PROFILES[cfg.profile], ...(cfg.budgetOverrides || {}) },
    paths: cfg.paths,
    totals: newTurnTotals(),
  };
}

export function endPolicyTurn(): void {
  gate = undefined;
}

export function activeProfile(): AutonomyProfile {
  return gate?.profile ?? 'interactive';
}

/** True once the turn has burned its budget — the loop should stop. */
export function budgetTripped(): PolicyVerdict | undefined {
  return gate?.tripped;
}

const OK: PolicyVerdict = { allowed: true };

/** Gate one file mutation about to happen. Records it into the totals when allowed. */
export function gateMutation(
  relPath: string,
  delta: { isNew?: boolean; addedLines?: number; deletedLines?: number } = {}
): PolicyVerdict {
  if (!gate || !relPath) { return OK; }
  if (gate.tripped) { return gate.tripped; }
  const pathVerdict = checkPath(relPath, gate.paths, gate.profile);
  if (!pathVerdict.allowed) { return pathVerdict; }
  const budgetVerdict = checkBudget(relPath, gate.totals, gate.budget, delta);
  if (!budgetVerdict.allowed) {
    gate.tripped = budgetVerdict;
    return budgetVerdict;
  }
  noteMutation(gate.totals, relPath, delta);
  return OK;
}

/**
 * Check a mutation WITHOUT recording it — for validation passes that must
 * reject before anything is written (apply_patch phase 1, rename preflight,
 * probe placement). Path rules always apply; the budget is only previewed.
 */
export function previewMutation(
  relPath: string,
  delta: { isNew?: boolean; addedLines?: number; deletedLines?: number } = {}
): PolicyVerdict {
  if (!gate || !relPath) { return OK; }
  if (gate.tripped) { return gate.tripped; }
  const pathVerdict = checkPath(relPath, gate.paths, gate.profile);
  if (!pathVerdict.allowed) { return pathVerdict; }
  return checkBudget(relPath, gate.totals, gate.budget, delta);
}

/** Gate one tool invocation (counts toward maxToolCalls / wall time). */
export function gateToolCall(): PolicyVerdict {
  if (!gate) { return OK; }
  if (gate.tripped) { return gate.tripped; }
  const v = checkToolCall(gate.totals, gate.budget);
  if (!v.allowed) { gate.tripped = v; }
  return v;
}

/** Gate a shell command (autonomous profiles refuse publish/deploy/push/installs). */
export function gateCommand(command: string): PolicyVerdict {
  if (!gate) { return OK; }
  return checkCommand(command, gate.profile);
}

/**
 * Whether an interactive confirmation prompt is possible. In autonomous
 * profiles nobody is watching — a would-be prompt must become a refusal.
 */
export function canPrompt(): boolean {
  return (gate?.profile ?? 'interactive') === 'interactive';
}
