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

/**
 * Applied to AUTONOMOUS missions; interactive missions stay unlimited unless
 * configured. The single source of the defaults: package.json repeats them for
 * the Settings UI and a test keeps the two identical. (Raised 16× in v1.43.0 from
 * the v1.42 values 12 turns / 600 calls / 1.5M tokens / 90 min / 3 stalled.)
 *
 * Tokens dominate in practice: every model call re-sends the whole prompt, so
 * one busy turn of ~140 tool calls at ~36k prompt tokens already costs ~5M.
 * The token ceiling is therefore sized for real agent turns, not for text volume.
 */
export const DEFAULT_MISSION_BUDGET: MissionBudget = {
  maxTurns: 192,
  maxToolCalls: 9600,
  maxTokens: 24_000_000,
  maxWallMs: 1440 * 60_000,
  maxStalledTurns: 48,
};

/** The user-facing shape: wall time in MINUTES, as the settings expose it. */
export interface MissionBudgetSettings {
  maxTurns?: unknown;
  maxToolCalls?: unknown;
  maxTokens?: unknown;
  maxWallMinutes?: unknown;
  maxStalledTurns?: unknown;
}

/**
 * Settings → budget overrides. Anything that is not a finite non-negative
 * number is left out, so resolveMissionBudget falls back to the default for it.
 */
export function missionBudgetFromSettings(s: MissionBudgetSettings): Partial<MissionBudget> {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
  const out: Partial<MissionBudget> = {};
  const turns = num(s.maxTurns); if (turns !== undefined) { out.maxTurns = turns; }
  const calls = num(s.maxToolCalls); if (calls !== undefined) { out.maxToolCalls = calls; }
  const tokens = num(s.maxTokens); if (tokens !== undefined) { out.maxTokens = tokens; }
  const minutes = num(s.maxWallMinutes); if (minutes !== undefined) { out.maxWallMs = minutes * 60_000; }
  const stalled = num(s.maxStalledTurns); if (stalled !== undefined) { out.maxStalledTurns = stalled; }
  return out;
}

/** Budget → the user-facing shape (for the settings dialog). */
export function missionBudgetToSettings(b: MissionBudget): Required<{ [K in keyof MissionBudgetSettings]: number }> {
  return { maxTurns: b.maxTurns, maxToolCalls: b.maxToolCalls, maxTokens: b.maxTokens,
    maxWallMinutes: Math.round(b.maxWallMs / 60_000), maxStalledTurns: b.maxStalledTurns };
}

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

/**
 * How close the mission is to its ceiling — so the MODEL can steer by it, not
 * only the controller. Without this the budget was a wall the agent could not
 * see: it spent 80% on polish and research and was then cut off mid-build.
 *
 * `fraction` is the most-used of the configured limits (turns, tool calls,
 * tokens, wall time); stalled turns are reported separately because they are a
 * "change approach" signal, not a cost.
 */
export type MissionBudgetStage = 'normal' | 'prioritise' | 'wrap-up' | 'exhausted';

export interface MissionBudgetPressure {
  stage: MissionBudgetStage;
  fraction: number;
  /** Which limit is closest ('tokens', 'turns', 'tool calls', 'time'). */
  binding: string;
  remainingTokens?: number;
  remainingTurns?: number;
  remainingToolCalls?: number;
  remainingMinutes?: number;
}

const STAGE_RANK: Record<MissionBudgetStage, number> = { normal: 0, prioritise: 1, 'wrap-up': 2, exhausted: 3 };

/** True when `next` asks for more restraint than `previous`. */
export function stageEscalated(previous: MissionBudgetStage, next: MissionBudgetStage): boolean {
  return STAGE_RANK[next] > STAGE_RANK[previous];
}

export function missionBudgetPressure(usage: MissionUsage, budget: MissionBudget): MissionBudgetPressure | undefined {
  const tokens = usage.promptTokens + usage.completionTokens;
  const dims: Array<[string, number, number]> = [
    ['tokens', tokens, budget.maxTokens], ['turns', usage.turns, budget.maxTurns],
    ['tool calls', usage.toolCalls, budget.maxToolCalls], ['time', usage.wallMs, budget.maxWallMs],
  ];
  const limited = dims.filter(([, , max]) => max > 0);
  if (!limited.length) { return undefined; }
  let binding = limited[0][0];
  let fraction = 0;
  for (const [name, used, max] of limited) {
    const f = used / max;
    if (f > fraction) { fraction = f; binding = name; }
  }
  const stage: MissionBudgetStage = fraction >= 1 ? 'exhausted' : fraction >= 0.8 ? 'wrap-up' : fraction >= 0.5 ? 'prioritise' : 'normal';
  const left = (max: number, used: number) => (max > 0 ? Math.max(0, max - used) : undefined);
  const out: MissionBudgetPressure = { stage, fraction, binding };
  const rt = left(budget.maxTokens, tokens); if (rt !== undefined) { out.remainingTokens = rt; }
  const ru = left(budget.maxTurns, usage.turns); if (ru !== undefined) { out.remainingTurns = ru; }
  const rc = left(budget.maxToolCalls, usage.toolCalls); if (rc !== undefined) { out.remainingToolCalls = rc; }
  const rm = left(budget.maxWallMs, usage.wallMs); if (rm !== undefined) { out.remainingMinutes = Math.floor(rm / 60_000); }
  return out;
}

/** Mission usage including the turn that is still running. */
export function liveMissionUsage(usage: MissionUsage, turn: { toolCalls: number; promptTokens: number; completionTokens: number; elapsedMs: number }): MissionUsage {
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return {
    ...usage,
    // turns stays at the COMPLETED count, as in checkMissionBudget: the turn that
    // is running was allowed to start, so it must not read as "turns exhausted".
    toolCalls: usage.toolCalls + n(turn.toolCalls),
    promptTokens: usage.promptTokens + n(turn.promptTokens),
    completionTokens: usage.completionTokens + n(turn.completionTokens),
    wallMs: usage.wallMs + n(turn.elapsedMs),
  };
}

const STAGE_GUIDANCE: Record<MissionBudgetStage, string> = {
  normal: 'Plan the work so the acceptance criteria fit well inside what remains.',
  prioritise: 'More than half is spent: do the acceptance criteria that matter most first, and leave polish, ' +
    'optional research and nice-to-haves until those pass.',
  'wrap-up': 'The budget is nearly spent: start no new features, experiments or research. Bring what exists to a ' +
    'working, verified state, then deliver with a short list of what is unfinished.',
  exhausted: 'The budget is SPENT: make no more tool calls. Reply now with the final report — what works (with the ' +
    'evidence), what is unfinished, and the next step — and stop. The mission will be paused after this reply.',
};

/**
 * The controller's budget note for the model. `avgPromptPerCall` (when known)
 * turns the token count into something a model can plan with: model calls left.
 */
export function missionBudgetNote(usage: MissionUsage, budget: MissionBudget, avgPromptPerCall?: number): string {
  const p = missionBudgetPressure(usage, budget);
  if (!p) { return ''; }
  const fmt = (v: number) => v.toLocaleString('en-US');
  const parts: string[] = [];
  if (p.remainingTokens !== undefined) {
    const calls = avgPromptPerCall && avgPromptPerCall > 0 ? ` (≈${fmt(Math.floor(p.remainingTokens / avgPromptPerCall))} model calls at the current prompt size)` : '';
    parts.push(`${fmt(p.remainingTokens)} tokens${calls}`);
  }
  if (p.remainingTurns !== undefined) { parts.push(`${fmt(p.remainingTurns)} turns (this one included)`); }
  if (p.remainingToolCalls !== undefined) { parts.push(`${fmt(p.remainingToolCalls)} tool calls`); }
  if (p.remainingMinutes !== undefined) { parts.push(`${fmt(p.remainingMinutes)} min`); }
  let note = `MISSION BUDGET (the controller pauses this mission when any limit is reached): ` +
    `${Math.min(100, Math.round(p.fraction * 100))}% used, closest limit: ${p.binding}. Remaining: ${parts.join(', ')}.\n` +
    STAGE_GUIDANCE[p.stage];
  if (budget.maxStalledTurns > 0 && usage.stalledTurns > 0) {
    note += `\n${usage.stalledTurns} turn(s) in a row changed nothing and produced no passing check ` +
      `(the mission pauses at ${budget.maxStalledTurns}): change the approach instead of repeating it.`;
  }
  return note;
}
