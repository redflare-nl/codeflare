import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MISSION_BUDGET, UNLIMITED_MISSION_BUDGET, accumulateMissionUsage, checkMissionBudget, coerceMissionUsage,
  describeMissionUsage, newMissionUsage, resolveMissionBudget,
} from '../src/engine/missionBudget';

const cost = (over: Partial<Parameters<typeof accumulateMissionUsage>[1]> = {}) =>
  ({ toolCalls: 10, promptTokens: 1000, completionTokens: 200, durationMs: 60_000, progressed: true, ...over });

describe('mission budget', () => {
  it('accumulates turns and resets the stall counter on progress', () => {
    let u = newMissionUsage();
    u = accumulateMissionUsage(u, cost({ progressed: false }));
    u = accumulateMissionUsage(u, cost({ progressed: false }));
    expect(u).toMatchObject({ turns: 2, toolCalls: 20, promptTokens: 2000, completionTokens: 400, wallMs: 120_000, stalledTurns: 2 });
    u = accumulateMissionUsage(u, cost({ progressed: true }));
    expect(u.stalledTurns).toBe(0);
    expect(u.turns).toBe(3);
  });

  it('ignores negative or non-finite turn costs instead of corrupting the total', () => {
    const u = accumulateMissionUsage(newMissionUsage(), cost({ toolCalls: -5, promptTokens: NaN, durationMs: Infinity }));
    expect(u).toMatchObject({ toolCalls: 0, promptTokens: 0, wallMs: 0 });
  });

  it('stops a stalled mission before any other limit', () => {
    const u = { ...newMissionUsage(), turns: 100, stalledTurns: DEFAULT_MISSION_BUDGET.maxStalledTurns };
    const v = checkMissionBudget(u, DEFAULT_MISSION_BUDGET);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('MISSION_STALLED');
    expect(v.reason).toMatch(/consecutive turn/);
  });

  it('enforces each ceiling and names the one that tripped', () => {
    const b = { maxTurns: 3, maxToolCalls: 50, maxTokens: 5000, maxWallMs: 10 * 60_000, maxStalledTurns: 0 };
    expect(checkMissionBudget({ ...newMissionUsage(), turns: 3 }, b).code).toBe('MISSION_TURNS');
    expect(checkMissionBudget({ ...newMissionUsage(), toolCalls: 50 }, b).code).toBe('MISSION_TOOL_CALLS');
    expect(checkMissionBudget({ ...newMissionUsage(), promptTokens: 4000, completionTokens: 1000 }, b).code).toBe('MISSION_TOKENS');
    expect(checkMissionBudget({ ...newMissionUsage(), wallMs: 10 * 60_000 }, b).code).toBe('MISSION_WALL_TIME');
    expect(checkMissionBudget({ ...newMissionUsage(), turns: 2, toolCalls: 49 }, b).allowed).toBe(true);
  });

  it('0 means unlimited', () => {
    const u = { turns: 10_000, toolCalls: 10_000, promptTokens: 1e9, completionTokens: 1e9, wallMs: 1e12, stalledTurns: 50 };
    expect(checkMissionBudget(u, UNLIMITED_MISSION_BUDGET).allowed).toBe(true);
  });

  it('resolves user overrides onto the defaults, rejecting junk', () => {
    const b = resolveMissionBudget(DEFAULT_MISSION_BUDGET, { maxTurns: 20, maxTokens: -1, maxWallMs: 'lots', maxStalledTurns: 5.9 });
    expect(b).toEqual({ ...DEFAULT_MISSION_BUDGET, maxTurns: 20, maxStalledTurns: 5 });
    expect(resolveMissionBudget(DEFAULT_MISSION_BUDGET, null)).toEqual(DEFAULT_MISSION_BUDGET);
  });

  it('coerces persisted usage defensively', () => {
    expect(coerceMissionUsage({ turns: 2.7, toolCalls: 'x', wallMs: -3, stalledTurns: 1 })).toEqual({ ...newMissionUsage(), turns: 2, stalledTurns: 1 });
    expect(coerceMissionUsage('nonsense')).toEqual(newMissionUsage());
  });

  it('describes usage against its limits in one line', () => {
    const line = describeMissionUsage({ ...newMissionUsage(), turns: 2, toolCalls: 30, promptTokens: 12_000, completionTokens: 500, wallMs: 3 * 60_000, stalledTurns: 1 }, DEFAULT_MISSION_BUDGET);
    expect(line).toBe('turns 2/12 · tool calls 30/600 · tokens 12,500/1,500,000 · 3 min/90 · stalled 1/3');
  });
});
