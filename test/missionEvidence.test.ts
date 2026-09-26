import { describe, expect, it } from 'vitest';
import { currentEvidence, EvidenceItem, makeEvidence, verificationSummary } from '../src/engine/evidence';
import { decideAcceptance } from '../src/engine/experiment';

function check(checkId: string, result: EvidenceItem['result']): EvidenceItem {
  return { ...makeEvidence('TEST', 'gate:auto-test', `${checkId}: ${result}`, result, 'post-edit'), checkId };
}

function decision(evidence: EvidenceItem[]) {
  return decideAcceptance({
    evidence, gates: { diagnostics: 'clean', verify: 'clean', diffReview: 'ok' },
    filesChanged: 2, outcome: 'completed', behaviorRequired: true,
  }).decision;
}

describe('mission evidence after repair', () => {
  it('accepts the latest passing result for the same test while retaining the audit history', () => {
    const failed = check('auto-test:npm test', 'fail');
    const passed = check('auto-test:npm test', 'pass');
    const history = [failed, passed];
    expect(currentEvidence(history)).toEqual([passed]);
    expect(history).toEqual([failed, passed]);
    expect(decision(history)).toBe('ACCEPTED');
    expect(verificationSummary(history).behavioralFailed).toBe(0);
  });

  it('does not clear an unrelated failed test when a different command passes', () => {
    const history = [check('auto-test:npm test', 'fail'), check('auto-test:npm run test:unit', 'pass')];
    expect(currentEvidence(history)).toEqual(history);
    expect(decision(history)).toBe('REJECTED');
  });

  it('keeps independent evidence with no repeatable identity', () => {
    const failure = makeEvidence('RUNTIME', 'run_command', 'Upload request returned 500', 'fail', 'post-edit');
    const passed = check('auto-test:npm test', 'pass');
    expect(currentEvidence([failure, passed])).toEqual([failure, passed]);
    expect(decision([failure, passed])).toBe('REJECTED');
  });

  it('rejects a regression even when the previous run passed', () => {
    expect(decision([check('auto-test:npm test', 'pass'), check('auto-test:npm test', 'fail')])).toBe('REJECTED');
  });

  it.each(['info', 'inconclusive'] as const)('does not accept an unresolved %s rerun as behavioral verification', result => {
    const history = [check('auto-test:npm test', 'fail'), check('auto-test:npm test', result)];
    expect(currentEvidence(history)).toEqual([history[1]]);
    expect(decision(history)).toBe('NEEDS_REVIEW');
  });
});
