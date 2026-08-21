import { describe, expect, it } from 'vitest';
import {
  compareMetrics,
  parseMetricValue,
  parseVerificationConfig,
  renderMetricComparisons,
} from '../src/engine/verificationConfig';

describe('parseVerificationConfig (fails safely, never silently)', () => {
  it('parses a full valid config', () => {
    const r = parseVerificationConfig(JSON.stringify({
      verify: ['npm run typecheck', 'npm test'],
      metrics: {
        fps: { command: 'node bench.js', direction: 'higher', maxRegressionPercent: 5 },
        errors: { command: 'node count.js', direction: 'lower', required: true },
      },
      metricTimeoutMs: 30000,
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.verify).toHaveLength(2);
      expect(r.config.metrics.fps.maxRegressionPercent).toBe(5);
      expect(r.config.metrics.errors.required).toBe(true);
      expect(r.config.metricTimeoutMs).toBe(30000);
    }
  });

  it('accepts a single verify command string', () => {
    const r = parseVerificationConfig('{"verify": "make check"}');
    expect(r.ok && r.config.verify).toEqual(['make check']);
  });

  it('rejects malformed JSON with an explicit error', () => {
    const r = parseVerificationConfig('{"verify": [');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain('not valid JSON'); }
  });

  for (const [name, bad] of [
    ['non-object root', '"just a string"'],
    ['metric without command', '{"metrics": {"fps": {"direction": "higher"}}}'],
    ['metric with bad direction', '{"metrics": {"fps": {"command": "x", "direction": "up"}}}'],
    ['negative threshold', '{"metrics": {"fps": {"command": "x", "direction": "higher", "maxRegressionPercent": -1}}}'],
    ['non-string verify entry', '{"verify": [42]}'],
  ] as const) {
    it(`rejects ${name}`, () => {
      expect(parseVerificationConfig(bad).ok).toBe(false);
    });
  }
});

describe('parseMetricValue', () => {
  it('takes the LAST numeric token', () => {
    expect(parseMetricValue('ran 3 scenarios\nfps: 61.5')).toBe(61.5);
    expect(parseMetricValue('errors: -0')).toBe(0);
  });
  it('returns undefined for non-numeric output', () => {
    expect(parseMetricValue('all good')).toBeUndefined();
    expect(parseMetricValue('')).toBeUndefined();
  });
});

describe('compareMetrics (fail-closed)', () => {
  const specs = {
    fps: { command: 'x', direction: 'higher' as const, maxRegressionPercent: 5 },
    errors: { command: 'y', direction: 'lower' as const, required: true },
  };

  it('passes improvements and within-threshold regressions', () => {
    const rows = compareMetrics(specs, { fps: 60, errors: 2 }, { fps: 58, errors: 0 });
    // fps −3.3% is inside the 5% allowance; errors improved.
    expect(rows.every(r => r.ok)).toBe(true);
  });

  it('fails a regression beyond the threshold', () => {
    const rows = compareMetrics(specs, { fps: 60, errors: 0 }, { fps: 50, errors: 0 });
    const fps = rows.find(r => r.name === 'fps')!;
    expect(fps.ok).toBe(false);
    expect(fps.detail).toContain('FAIL');
  });

  it('any regression fails when no threshold is configured (default 0)', () => {
    const rows = compareMetrics(specs, { fps: 60, errors: 0 }, { fps: 60, errors: 1 });
    expect(rows.find(r => r.name === 'errors')!.ok).toBe(false);
  });

  it('a REQUIRED metric with no measurable value fails; an optional one only reports', () => {
    const rows = compareMetrics(specs, { fps: undefined, errors: undefined }, { fps: 60, errors: 0 });
    expect(rows.find(r => r.name === 'errors')!.ok).toBe(false);      // required
    expect(rows.find(r => r.name === 'fps')!.ok).toBe(true);          // optional → visible, not fatal
    expect(rows.find(r => r.name === 'fps')!.detail).toContain('not measured');
  });

  it('renders ✓/✗ rows', () => {
    const text = renderMetricComparisons(
      compareMetrics(specs, { fps: 60, errors: 0 }, { fps: 30, errors: 0 }));
    expect(text).toContain('✗ fps');
    expect(text).toContain('✓ errors');
  });
});
