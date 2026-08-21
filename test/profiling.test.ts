import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ScalingSample,
  buildScalingHarness,
  fitScaling,
  parseCpuProfile,
  renderHotPaths,
} from '../src/engine/profiling';
import { parseLabResult } from '../src/engine/labHarness';

function runNode(code: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-prof-test-'));
  const file = join(dir, 'main.js');
  writeFileSync(file, code);
  return execFileSync('node', [file], { encoding: 'utf8', timeout: 60000 });
}

describe('parseCpuProfile', () => {
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)' }, children: [2, 3, 4] },
      { id: 2, callFrame: { functionName: 'hotFn', url: 'file:///proj/src/hot.js' } },
      { id: 3, callFrame: { functionName: 'coldFn', url: 'file:///proj/src/cold.js' } },
      { id: 4, callFrame: { functionName: '(garbage collector)' } },
    ],
    // 8 samples in hotFn, 2 in coldFn, 5 in GC — 100us each.
    samples: [2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 4, 4, 4, 4, 4],
    timeDeltas: Array(15).fill(100),
  };

  it('ranks by self time and drops V8 bookkeeping frames', () => {
    const { paths } = parseCpuProfile(profile as any, 10);
    expect(paths[0].name).toBe('hotFn');
    expect(paths.map(p => p.name)).not.toContain('(garbage collector)');
    // GC excluded from the actionable total: 8 of 10 real samples.
    expect(paths[0].selfPct).toBeCloseTo(80, 0);
  });

  it('renders a compact ranked report', () => {
    const { total, paths } = parseCpuProfile(profile as any, 10);
    const text = renderHotPaths(total, paths);
    expect(text).toContain('hotFn');
    expect(text).toContain('%');
    expect(text.split('\n').length).toBeLessThan(8);
  });

  it('tells the model what to do when there are no samples', () => {
    expect(renderHotPaths(0, [])).toContain('too short');
  });
});

describe('fitScaling', () => {
  const gen = (f: (n: number) => number): ScalingSample[] =>
    [100, 200, 400, 800, 1600].map(n => ({ n, ms: f(n) }));

  it('recognizes linear growth', () => {
    expect(fitScaling(gen(n => n * 0.01)).best).toBe('~n');
  });

  it('recognizes quadratic growth', () => {
    expect(fitScaling(gen(n => n * n * 0.0001)).best).toBe('~n^2');
  });

  it('recognizes constant time', () => {
    expect(fitScaling(gen(() => 0.5)).best).toBe('~constant');
  });

  it('refuses to conclude from too few points', () => {
    const fit = fitScaling([{ n: 100, ms: 1 }, { n: 200, ms: 2 }]);
    expect(fit.unreliable).toBe(true);
    expect(fit.best).toBe('unknown');
  });

  it('flags timer-resolution noise as low confidence', () => {
    expect(fitScaling(gen(() => 0.001)).unreliable).toBe(true);
  });
});

describe('scaling harness (javascript, executed for real)', () => {
  it('measures a quadratic loop and the fit identifies it', () => {
    const harness = buildScalingHarness(
      'javascript',
      'function work(n) { let s = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) s += i ^ j; return s; }',
      'work(n);',
      [200, 400, 800, 1600, 3200],
      5
    );
    const out = runNode(harness);
    const parsed = parseLabResult<{ samples: ScalingSample[] }>(out);
    expect(parsed!.samples.length).toBe(5);
    const fit = fitScaling(parsed!.samples);
    // Quadratic work must not be mistaken for anything below n log n.
    expect(['~n^2', '~n^3']).toContain(fit.best);
  });
});
