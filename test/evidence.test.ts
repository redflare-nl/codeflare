import { describe, expect, it } from 'vitest';
import {
  classifyToolEvidence,
  isBehavioral,
  makeEvidence,
  renderEvidenceLine,
  verificationSummary,
} from '../src/engine/evidence';

describe('classifyToolEvidence', () => {
  it('classifies a passing command as RUNTIME/pass with the legacy line shape', () => {
    const item = classifyToolEvidence(
      'run_command', '{"command":"npm test"}', 'exit code: 0\nall green', 'post-edit');
    expect(item).toBeDefined();
    expect(item!.type).toBe('RUNTIME');
    expect(item!.result).toBe('pass');
    expect(renderEvidenceLine(item!)).toBe('[post-edit] run: npm test → ok');
  });

  it('classifies a failing command as fail', () => {
    const item = classifyToolEvidence('run_command', '{"command":"npm test"}', 'exit code: 1', 'pre-edit');
    expect(item!.result).toBe('fail');
    expect(renderEvidenceLine(item!)).toContain('FAILED');
  });

  it('tags dependency installs as a side effect', () => {
    const item = classifyToolEvidence(
      'run_command', '{"command":"npm install lodash"}', 'exit code: 0', 'post-edit');
    expect(item!.tags).toContain('dependency-install');
    expect(item!.description).toContain('installs a dependency');
  });

  it('maps verify_visual verdicts to pass/fail', () => {
    const ok = classifyToolEvidence('verify_visual', '{"path":"a.png"}', 'VERDICT: OK — looks right', 'post-edit');
    const bad = classifyToolEvidence('verify_visual', '{"path":"a.png"}', 'VERDICT: MISMATCH — missing header', 'post-edit');
    expect(ok!.type).toBe('VISUAL_COMPARISON');
    expect(ok!.result).toBe('pass');
    expect(bad!.result).toBe('fail');
  });

  it('classifies probes as behavioural PROBE evidence', () => {
    const item = classifyToolEvidence('read_probes', '{}', 'p1: 12 hits, avg 3ms', 'post-edit');
    expect(item!.type).toBe('PROBE');
    expect(isBehavioral(item!)).toBe(true);
  });

  it('returns undefined for reads/edits (the diff covers edits)', () => {
    expect(classifyToolEvidence('read_file', '{"path":"a.ts"}', '…', 'pre-edit')).toBeUndefined();
    expect(classifyToolEvidence('edit_file', '{}', 'Edited a.ts', 'post-edit')).toBeUndefined();
  });
});

describe('verificationSummary', () => {
  it('reports UNVERIFIED when there is no evidence at all', () => {
    expect(verificationSummary([]).label).toBe('UNVERIFIED');
  });

  it('never upgrades static checks to behavioural', () => {
    const s = verificationSummary([
      makeEvidence('BUILD', 'gate:verify', 'tsc → passed', 'pass', 'post-edit'),
      makeEvidence('DIAGNOSTIC', 'gate:diagnostics', 'no new errors', 'pass', 'post-edit'),
    ]);
    expect(s.behavioral).toBe(0);
    expect(s.label).toBe('STATIC-ONLY');
  });

  it('labels TESTED when behaviour was exercised and MEASURED when quantified', () => {
    const tested = verificationSummary([
      makeEvidence('RUNTIME', 'run_command', 'run: node app.js → ok', 'pass', 'post-edit'),
    ]);
    expect(tested.label).toBe('TESTED');
    const measured = verificationSummary([
      makeEvidence('PROBE', 'read_probes', 'p1: 100 hits, avg 2ms', 'pass', 'post-edit'),
    ]);
    expect(measured.label).toBe('MEASURED');
  });
});
