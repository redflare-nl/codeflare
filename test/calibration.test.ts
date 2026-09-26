import { describe, expect, it } from 'vitest';
import { CALIBRATION, calibrationPolicy, computeCalibration } from '../src/engine/calibration';

/**
 * The loop this closes: metrics record claimed-vs-demonstrated per model, and
 * a measured over-claim habit must change the review — but only on a sample
 * that means something.
 */

const turn = (model: string, outcome: string, verified: string, i: number) =>
  ({ model, outcome, verified, ts: new Date(1_700_000_000_000 + i * 60_000).toISOString() });

function history(model: string, pattern: string[]): ReturnType<typeof turn>[] {
  // pattern entries: 'C' clean, 'N' not-run, 'F' failed, 'S' stopped (not claimed)
  return pattern.map((p, i) => p === 'S' ? turn(model, 'stopped', 'not-run', i)
    : turn(model, 'completed', p === 'C' ? 'clean' : p === 'F' ? 'failed' : 'not-run', i));
}

describe('computeCalibration', () => {
  it('counts only the named model and only claimed-done turns', () => {
    const records = [...history('a', ['C', 'N', 'S']), ...history('b', ['N', 'N'])];
    const cal = computeCalibration(records, 'a');
    expect(cal).toMatchObject({ model: 'a', turns: 3, claimedDone: 2, demonstrated: 1, unverified: 1, failed: 0, overclaimRate: 0.5, sample: 'thin' });
  });

  it('uses the most recent window by timestamp', () => {
    const old = history('m', Array(20).fill('N'));          // an old bad streak
    const recent = history('m', Array(20).fill('C')).map((r, i) => ({ ...r, ts: new Date(1_800_000_000_000 + i * 60_000).toISOString() }));
    const cal = computeCalibration([...old, ...recent], 'm', 10);
    expect(cal.turns).toBe(10);
    expect(cal.demonstrated).toBe(10);
    expect(cal.overclaimRate).toBe(0);
  });

  it('reports no sample when nothing was claimed', () => {
    expect(computeCalibration(history('m', ['S', 'S']), 'm').sample).toBe('none');
    expect(computeCalibration([], 'm').sample).toBe('none');
  });
});

describe('calibrationPolicy', () => {
  it('does nothing on a thin sample, however bad it looks', () => {
    const cal = computeCalibration(history('m', Array(CALIBRATION.minClaimed - 1).fill('N')), 'm');
    expect(calibrationPolicy(cal)).toEqual({ requireBehavioralEvidence: false, note: '' });
  });

  it('makes a behavioural check mandatory for a measured over-claimer, and says so with the numbers', () => {
    const cal = computeCalibration(history('m', ['N', 'N', 'N', 'F', 'C', 'N', 'C', 'N', 'C', 'N']), 'm');
    expect(cal.overclaimRate).toBeGreaterThanOrEqual(CALIBRATION.strictAt);
    const policy = calibrationPolicy(cal);
    expect(policy.requireBehavioralEvidence).toBe(true);
    expect(policy.note).toMatch(/last 10 turns reported as done/);
    expect(policy.note).toMatch(/only 3/);
    expect(policy.note).toMatch(/mandatory/);
  });

  it('acknowledges a reliable record without tightening anything', () => {
    const cal = computeCalibration(history('m', ['C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'N', 'C']), 'm');
    const policy = calibrationPolicy(cal);
    expect(policy.requireBehavioralEvidence).toBe(false);
    expect(policy.note).toMatch(/9 of your last 10/);
    expect(policy.note).toMatch(/Keep verifying/);
  });

  it('nudges without tightening in the middle band', () => {
    const cal = computeCalibration(history('m', ['C', 'C', 'C', 'N', 'C', 'C', 'N', 'C', 'C', 'N']), 'm');
    const policy = calibrationPolicy(cal);
    expect(policy.requireBehavioralEvidence).toBe(false);
    expect(policy.note).toMatch(/30% were not/);
  });
});
