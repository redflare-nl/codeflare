import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MISSION_BUDGET, MissionBudget, UNLIMITED_MISSION_BUDGET, checkMissionBudget, liveMissionUsage,
  missionBudgetNote, missionBudgetPressure, newMissionUsage, stageEscalated,
} from '../src/engine/missionBudget';

const budget: MissionBudget = { maxTurns: 10, maxToolCalls: 1000, maxTokens: 1_000_000, maxWallMs: 60 * 60_000, maxStalledTurns: 3 };
const usage = (tokens: number, over: Partial<ReturnType<typeof newMissionUsage>> = {}) =>
  ({ ...newMissionUsage(), promptTokens: tokens, ...over });

describe('mission budget pressure — the model can steer by what is left', () => {
  it('moves through the stages on the most-used limit', () => {
    expect(missionBudgetPressure(usage(100_000), budget)).toMatchObject({ stage: 'normal', binding: 'tokens', remainingTokens: 900_000 });
    expect(missionBudgetPressure(usage(500_000), budget)?.stage).toBe('prioritise');
    expect(missionBudgetPressure(usage(800_000), budget)?.stage).toBe('wrap-up');
    expect(missionBudgetPressure(usage(1_000_000), budget)?.stage).toBe('exhausted');
    // Another limit can be the binding one.
    expect(missionBudgetPressure(usage(10, { toolCalls: 900 }), budget)).toMatchObject({ stage: 'wrap-up', binding: 'tool calls' });
  });

  it('says nothing when no limit is configured', () => {
    expect(missionBudgetPressure(usage(5_000_000), UNLIMITED_MISSION_BUDGET)).toBeUndefined();
    expect(missionBudgetNote(usage(5_000_000), UNLIMITED_MISSION_BUDGET)).toBe('');
  });

  it('counts the running turn\'s cost but not the turn itself, matching the between-turn check', () => {
    const done = usage(0, { turns: 9 });
    const live = liveMissionUsage(done, { toolCalls: 5, promptTokens: 300, completionTokens: 20, elapsedMs: 1000 });
    expect(live).toMatchObject({ turns: 9, toolCalls: 5, promptTokens: 300, completionTokens: 20, wallMs: 1000 });
    // The 10th (last allowed) turn may start, so it must not open with "spent".
    expect(checkMissionBudget(done, budget).allowed).toBe(true);
    expect(missionBudgetPressure(live, budget)?.stage).not.toBe('exhausted');
  });

  it('only escalates, never repeats or relaxes a notice', () => {
    expect(stageEscalated('normal', 'prioritise')).toBe(true);
    expect(stageEscalated('prioritise', 'prioritise')).toBe(false);
    expect(stageEscalated('wrap-up', 'prioritise')).toBe(false);
    expect(stageEscalated('wrap-up', 'exhausted')).toBe(true);
  });

  it('turns tokens into model calls left and tells the model what to do', () => {
    const note = missionBudgetNote(usage(850_000), budget, 30_000);
    expect(note).toMatch(/85% used, closest limit: tokens/);
    expect(note).toMatch(/150,000 tokens \(≈5 model calls at the current prompt size\)/);
    expect(note).toMatch(/start no new features/);
    expect(missionBudgetNote(usage(1_000_000), budget)).toMatch(/make no more tool calls/);
    expect(missionBudgetNote(usage(100), budget)).toMatch(/Plan the work so the acceptance criteria fit/);
  });

  it('warns about stalled turns as a change-of-approach signal', () => {
    expect(missionBudgetNote(usage(100, { stalledTurns: 2 }), budget)).toMatch(/2 turn\(s\) in a row changed nothing.*pauses at 3/);
  });

  it('works on the shipped defaults (24M tokens is the binding limit in practice)', () => {
    const p = missionBudgetPressure(usage(12_000_000, { turns: 3, toolCalls: 400 }), DEFAULT_MISSION_BUDGET);
    expect(p).toMatchObject({ stage: 'prioritise', binding: 'tokens', remainingTokens: 12_000_000 });
  });
});
