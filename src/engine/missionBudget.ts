/**
 * Mission-level budget: the cumulative cost of a GOAL, not of one turn.
 *
 * policy.ts bounds a single turn. A mission spans many turns (fix rounds, test
 * stage, resumes), and without a ceiling on the whole it can keep going while
 * every individual turn stays within limits. This adds the outer bound plus a
 * stop rule that a turn budget cannot express: a mission that makes no
 * measurable progress for several turns is paused, not retried forever.
 *
 * Pure; the provider accumulates and consults it. 0 = unlimited, as in policy.
 */

export interface MissionUsage {
  turns: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  wallMs: number;
  /** Consecutive turns that changed no file and produced no passing evidence. */
  stalledTurns: number;
}

export interface MissionBudget {
  maxTurns: number;
  maxToolCalls: number;
  /** Prompt + completion tokens across the mission. */
  maxTokens: number;
  maxWallMs: number;
  maxStalledTurns: number;
}

export interface TurnCost {
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  /** The turn changed a file or produced passing evidence. */
  progressed: boolean;
}

export type MissionBudgetCode = 'MISSION_TURNS' | 'MISSION_TOOL_CALLS' | 'MISSION_TOKENS' | 'MISSION_WALL_TIME' | 'MISSION_STALLED';

export interface MissionBudgetVerdict {
  allowed: boolean;
  code?: MissionBudgetCode;
  reason?: string;
}

/** Applied to AUTONOMOUS missions; interactive missions stay unlimited unless configured. */
export const DEFAULT_MISSION_BUDGET: MissionBudget = {
  maxTurns: 12,
  maxToolCalls: 600,
  maxTokens: 1_500_000,
  maxWallMs: 90 * 60_000,
  maxStalledTurns: 3,
};

export const UNLIMITED_MISSION_BUDGET: MissionBudget = {
  maxTurns: 0, maxToolCalls: 0, maxTokens: 0, maxWallMs: 0, maxStalledTurns: 0,
};

export function newMissionUsage(): MissionUsage {
  return { turns: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, wallMs: 0, stalledTurns: 0 };
}

/** Coerce persisted or user-supplied data; anything malformed becomes a fresh zero. */
export function coerceMissionUsage(raw: unknown): MissionUsage {
  const usage = newMissionUsage();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { return usage; }
  for (const key of Object.keys(usage) as (keyof MissionUsage)[]) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) { usage[key] = Math.floor(v); }
  }
  return usage;
}

/** Merge partial user overrides onto a base; only finite non-negative numbers count. */
export function resolveMissionBudget(base: MissionBudget, overrides: unknown): MissionBudget {
  const budget = { ...base };
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) { return budget; }
  for (const key of Object.keys(budget) as (keyof MissionBudget)[]) {
    const v = (overrides as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) { budget[key] = Math.floor(v); }
  }
  return budget;
}

/** Returns a NEW usage with one finished turn added. */
export function accumulateMissionUsage(usage: MissionUsage, turn: TurnCost): MissionUsage {
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return {
    turns: usage.turns + 1,
    toolCalls: usage.toolCalls + n(turn.toolCalls),
    promptTokens: usage.promptTokens + n(turn.promptTokens),
    completionTokens: usage.completionTokens + n(turn.completionTokens),
    wallMs: usage.wallMs + n(turn.durationMs),
    stalledTurns: turn.progressed ? 0 : usage.stalledTurns + 1,
  };
}

/** Whether ANOTHER turn may start on this mission. */
export function checkMissionBudget(usage: MissionUsage, budget: MissionBudget): MissionBudgetVerdict {
  const over = (limit: number, value: number) => limit > 0 && value >= limit;
  if (over(budget.maxStalledTurns, usage.stalledTurns)) {
    return { allowed: false, code: 'MISSION_STALLED',
      reason: `${usage.stalledTurns} consecutive turn(s) changed nothing and produced no passing evidence (limit ${budget.maxStalledTurns})` };
  }
  if (over(budget.maxTurns, usage.turns)) {
    return { allowed: false, code: 'MISSION_TURNS', reason: `${usage.turns} turn(s) used (limit ${budget.maxTurns})` };
  }
  if (over(budget.maxToolCalls, usage.toolCalls)) {
    return { allowed: false, code: 'MISSION_TOOL_CALLS', reason: `${usage.toolCalls} tool call(s) used (limit ${budget.maxToolCalls})` };
  }
  const tokens = usage.promptTokens + usage.completionTokens;
  if (over(budget.maxTokens, tokens)) {
    return { allowed: false, code: 'MISSION_TOKENS', reason: `${tokens.toLocaleString('en-US')} token(s) used (limit ${budget.maxTokens.toLocaleString('en-US')})` };
  }
  if (over(budget.maxWallMs, usage.wallMs)) {
    return { allowed: false, code: 'MISSION_WALL_TIME',
      reason: `${Math.round(usage.wallMs / 60_000)} min of model time used (limit ${Math.round(budget.maxWallMs / 60_000)} min)` };
  }
  return { allowed: true };
}

/** One line for the UI. */
export function describeMissionUsage(usage: MissionUsage, budget: MissionBudget): string {
  const lim = (v: number) => (v > 0 ? `/${v}` : '');
  const tokens = usage.promptTokens + usage.completionTokens;
  return `turns ${usage.turns}${lim(budget.maxTurns)} · tool calls ${usage.toolCalls}${lim(budget.maxToolCalls)} · ` +
    `tokens ${tokens.toLocaleString('en-US')}${budget.maxTokens ? '/' + budget.maxTokens.toLocaleString('en-US') : ''} · ` +
    `${Math.round(usage.wallMs / 60_000)} min${budget.maxWallMs ? '/' + Math.round(budget.maxWallMs / 60_000) : ''}` +
    (usage.stalledTurns ? ` · stalled ${usage.stalledTurns}${lim(budget.maxStalledTurns)}` : '');
}
