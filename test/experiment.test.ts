import { describe, expect, it } from 'vitest';
import { makeEvidence } from '../src/engine/evidence';
import { decideAcceptance, DecisionInput, newExperiment } from '../src/engine/experiment';

const base = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  gates: { diagnostics: 'clean', verify: 'clean', diffReview: 'ok' },
  evidence: [makeEvidence('RUNTIME', 'run_command', 'run: npm test → ok', 'pass', 'post-edit')],
  filesChanged: 2,
  outcome: 'completed',
  behaviorRequired: false,
  ...over,
});

describe('decideAcceptance (fail-closed)', () => {
  it('accepts a clean, behaviourally-verified change', () => {
    const { decision, reasons } = decideAcceptance(base());
    expect(decision).toBe('ACCEPTED');
    expect(reasons).toEqual([]);
  });

  it('a failed verify command can NEVER be accepted', () => {
    const { decision, reasons } = decideAcceptance(base({
      gates: { diagnostics: 'clean', verify: 'failed', diffReview: 'ok' },
    }));
    expect(decision).toBe('REJECTED');
    expect(reasons.join(' ')).toContain('verify command');
  });

  it('failed diagnostics can NEVER be accepted', () => {
    const { decision } = decideAcceptance(base({
      gates: { diagnostics: 'failed', verify: 'clean' },
    }));
    expect(decision).toBe('REJECTED');
  });

  it('a failed behavioural check rejects even when all gates are green', () => {
    const { decision, reasons } = decideAcceptance(base({
      evidence: [
        makeEvidence('RUNTIME', 'run_command', 'run: node repro.js → FAILED', 'fail', 'post-edit'),
      ],
    }));
    expect(decision).toBe('REJECTED');
    expect(reasons[0]).toContain('behavioural check failed');
  });

  it('a stopped turn is INCONCLUSIVE, never accepted', () => {
    expect(decideAcceptance(base({ outcome: 'stopped' })).decision).toBe('INCONCLUSIVE');
  });

  it('no changed files → INCONCLUSIVE (nothing to accept)', () => {
    expect(decideAcceptance(base({ filesChanged: 0 })).decision).toBe('INCONCLUSIVE');
  });

  it('unmet requirements → NEEDS_REVIEW, not silent acceptance', () => {
    const { decision } = decideAcceptance(base({
      gates: { diagnostics: 'clean', verify: 'clean', diffReview: 'issues' },
    }));
    expect(decision).toBe('NEEDS_REVIEW');
  });

  it('nothing verified at all → NEEDS_REVIEW (green-by-default is impossible)', () => {
    const { decision, reasons } = decideAcceptance(base({
      gates: {},
      evidence: [],
    }));
    expect(decision).toBe('NEEDS_REVIEW');
    expect(reasons[0]).toContain('nothing was verified');
  });

  it('demanded-but-missing behavioural evidence → NEEDS_REVIEW', () => {
    const { decision, reasons } = decideAcceptance(base({
      behaviorRequired: true,
      evidence: [],   // static gates are green, but nothing behavioural
    }));
    expect(decision).toBe('NEEDS_REVIEW');
    expect(reasons[0]).toContain('behavioural verification was requested');
  });

  it('static-only acceptance carries an honest reason', () => {
    const { decision, reasons } = decideAcceptance(base({ evidence: [] }));
    expect(decision).toBe('ACCEPTED');
    expect(reasons[0]).toContain('static checks only');
  });
});

describe('newExperiment', () => {
  it('starts CREATED with the task preview bounded', () => {
    const exp = newExperiment('x'.repeat(1000), 'qwen', 'local');
    expect(exp.state).toBe('CREATED');
    expect(exp.task.length).toBe(500);
    expect(exp.filesChanged).toEqual([]);
  });
});
