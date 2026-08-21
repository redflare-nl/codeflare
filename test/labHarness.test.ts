import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BenchStats,
  DiffStats,
  buildBenchmarkHarness,
  buildDiffHarness,
  parseLabResult,
  renderBenchStats,
  renderDiffStats,
} from '../src/engine/labHarness';

/** Run a generated JS harness under the real node — the lab's primary runtime. */
function runNode(code: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-lab-test-'));
  const file = join(dir, 'main.js');
  writeFileSync(file, code);
  return execFileSync('node', [file], { encoding: 'utf8', timeout: 30000 });
}

describe('benchmark harness (javascript, executed for real)', () => {
  it('measures a function and reports sane stats', () => {
    const harness = buildBenchmarkHarness(
      'javascript',
      'const arr = Array.from({length: 500}, (_, i) => 500 - i);',
      'arr.slice().sort((a, b) => a - b);',
      50, 5
    );
    const out = runNode(harness);
    const stats = parseLabResult<BenchStats>(out);
    expect(stats).toBeDefined();
    expect(stats!.iterations).toBe(50);
    expect(stats!.errors).toBe(0);
    expect(stats!.meanMs).toBeGreaterThan(0);
    expect(stats!.p95Ms).toBeGreaterThanOrEqual(stats!.p50Ms);
    expect(stats!.maxMs).toBeGreaterThanOrEqual(stats!.p99Ms);
    expect(typeof stats!.heapDeltaKb).toBe('number');
  });

  it('counts throwing iterations as errors instead of dying', () => {
    const harness = buildBenchmarkHarness('javascript', '', 'throw new Error("boom");', 10, 0);
    const stats = parseLabResult<BenchStats>(runNode(harness));
    expect(stats!.errors).toBe(10);
  });
});

describe('differential harness (javascript, executed for real)', () => {
  it('reports full equivalence for actually-equivalent implementations', () => {
    const harness = buildDiffHarness(
      'javascript',
      'function oldImpl(xs) { return xs.slice().sort((a, b) => a - b); }',
      'function newImpl(xs) { return [...xs].sort((a, b) => a - b); }',
      'function gen(i) { return Array.from({length: i % 20}, (_, k) => ((i * 31 + k * 17) % 100) - 50); }',
      200
    );
    const stats = parseLabResult<DiffStats>(runNode(harness));
    expect(stats!.cases).toBe(200);
    expect(stats!.identical).toBe(200);
    expect(stats!.different).toBe(0);
    expect(renderDiffStats(stats!)).toContain('supports — but cannot prove');
  });

  it('catches a planted behavioural difference and returns the smallest failing input', () => {
    const harness = buildDiffHarness(
      'javascript',
      'function oldImpl(xs) { return xs.reduce((a, b) => a + b, 0); }',
      // BUG: skips negative numbers.
      'function newImpl(xs) { return xs.filter(x => x >= 0).reduce((a, b) => a + b, 0); }',
      'function gen(i) { return Array.from({length: (i % 10) + 1}, (_, k) => (i + k) % 7 - 3); }',
      300
    );
    const stats = parseLabResult<DiffStats>(runNode(harness));
    expect(stats!.different).toBeGreaterThan(0);
    expect(stats!.mismatches.length).toBeGreaterThan(0);
    expect(stats!.mismatches.length).toBeLessThanOrEqual(3);
    // Shrinking preference: the reported inputs are the smallest mismatches.
    const lens = stats!.mismatches.map(m => m.input.length);
    expect([...lens].sort((a, b) => a - b)).toEqual(lens);
    expect(renderDiffStats(stats!)).toContain('Smallest mismatching input');
  });

  it('rejects harnesses that do not define the required functions', () => {
    const harness = buildDiffHarness('javascript', 'const x = 1;', 'const y = 2;', 'const z = 3;', 10);
    let out = '';
    try { out = runNode(harness); } catch (e: any) { out = String(e.stdout || ''); }
    const res = parseLabResult<{ error?: string }>(out);
    expect(res?.error).toContain('must define');
  });
});

describe('parseLabResult', () => {
  it('ignores user prints and picks the result line', () => {
    const out = 'debug noise\nmore noise\nCF_LAB_RESULT:{"a":1}\n';
    expect(parseLabResult<{ a: number }>(out)).toEqual({ a: 1 });
  });

  it('returns undefined when the harness died before printing', () => {
    expect(parseLabResult('SyntaxError: unexpected token')).toBeUndefined();
  });
});

describe('renderBenchStats', () => {
  it('labels the heap delta as an estimate — never fabricated precision', () => {
    const text = renderBenchStats('fn', {
      iterations: 100, meanMs: 1.5, p50Ms: 1.2, p95Ms: 3.1, p99Ms: 4.0, maxMs: 5.5,
      errors: 0, heapDeltaKb: 42,
    });
    expect(text).toContain('ESTIMATE');
    expect(text).toContain('p95 3.10 ms');
  });
});
