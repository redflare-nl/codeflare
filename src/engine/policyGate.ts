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
  GUARDRAIL_PATHS,
  PathPolicy,
  PolicyVerdict,
  TurnTotals,
  checkBudget,
  checkCommand,
  checkGuardrailCommand,
  checkPath,
  checkToolCall,
  newTurnTotals,
  noteMutation,
} from './policy';
import { checkAgentMutation } from './agentScope';

/**
 * How the runtime's own guardrail files are treated this turn.
 *  - 'forbid'  — self-improvement: unwritable via file tools AND run_command.
 *  - 'protect' — any turn inside the CodeFlare repository: blocked in autonomous
 *                profiles, ordinary confirm flow when a human is watching.
 */
export type GuardrailMode = 'forbid' | 'protect';

interface ActiveGate {
  profile: AutonomyProfile;
  budget: ChangeBudget;
  paths: PathPolicy;
  totals: TurnTotals;
  guardrails?: GuardrailMode;
  /** Set once a budget verdict failed — everything after is refused fast. */
  tripped?: PolicyVerdict;
}

let gate: ActiveGate | undefined;

export interface PolicyTurnConfig {
  profile: AutonomyProfile;
  paths: PathPolicy;
  /** Optional per-field overrides on the profile's budget (0 = unlimited). */
  budgetOverrides?: Partial<ChangeBudget>;
  guardrails?: GuardrailMode;
}

export function beginPolicyTurn(cfg: PolicyTurnConfig): void {
  // Guardrails are added to the path policy itself, so every existing check
  // (gateMutation, previewMutation, apply_patch preflight) covers them with no
  // new code path to forget.
  const paths: PathPolicy = cfg.guardrails === 'forbid'
    ? { ...cfg.paths, forbiddenPaths: [...cfg.paths.forbiddenPaths, ...GUARDRAIL_PATHS] }
    : cfg.guardrails === 'protect'
      ? { ...cfg.paths, protectedPaths: [...cfg.paths.protectedPaths, ...GUARDRAIL_PATHS] }
      : cfg.paths;
  gate = {
    profile: cfg.profile,
    budget: { ...BUDGET_PROFILES[cfg.profile], ...(cfg.budgetOverrides || {}) },
    paths,
    totals: newTurnTotals(),
    guardrails: cfg.guardrails,
  };
}

/** The guardrail mode of the active turn, if any (for labels and logs). */
export function activeGuardrails(): GuardrailMode | undefined {
  return gate?.guardrails;
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
  const ownership = checkAgentMutation(relPath, false);
  if (!ownership.allowed) { return ownership; }
  if (!gate) { return checkAgentMutation(relPath, true); }
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
  checkAgentMutation(relPath, true);
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
  const ownership = checkAgentMutation(relPath, false);
  if (!ownership.allowed) { return ownership; }
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
  // Locked guardrails: the shell must not become the way around the file gate
  // (echo > policy.ts, git apply, or committing an edit so it looks like baseline).
  if (gate.guardrails === 'forbid') {
    const v = checkGuardrailCommand(command);
    if (!v.allowed) { return v; }
  }
  return checkCommand(command, gate.profile);
}

/**
 * Whether an interactive confirmation prompt is possible. In autonomous
 * profiles nobody is watching — a would-be prompt must become a refusal.
 */
export function canPrompt(): boolean {
  return (gate?.profile ?? 'interactive') === 'interactive';
}
