/**
 * Performance intelligence — pure helpers for hot-path discovery and observed
 * scaling. Execution lives in lab.ts; this module builds harnesses, parses
 * profiler output, and fits scaling curves.
 *
 * Honesty rules:
 *  - hot paths come from REAL profilers (V8 --cpu-prof, Python cProfile) — no
 *    guessing from code shape;
 *  - scaling fits are reported as OBSERVED SCALING on the measured sizes,
 *    never as proven complexity — five timings prove no theorem;
 *  - reports are compact and ranked; raw profiler dumps never reach the model.
 */

import { LAB_RESULT_PREFIX } from './labHarness';

// ── V8 .cpuprofile parsing ───────────────────────────────────────

export interface HotPath {
  name: string;
  file: string;
  selfMs: number;
  selfPct: number;
}

interface CpuProfileNode {
  id: number;
  callFrame: { functionName?: string; url?: string; lineNumber?: number };
  hitCount?: number;
  children?: number[];
}

interface CpuProfile {
  nodes: CpuProfileNode[];
  samples?: number[];
  timeDeltas?: number[];
}

/** Trim a script url to something the model can act on. */
function shortUrl(url: string): string {
  if (!url) { return '(internal)'; }
  return url.replace(/^file:\/\/\/?/, '').replace(/\\/g, '/').split('/').slice(-3).join('/');
}

/**
 * Aggregate a V8 .cpuprofile into ranked self-time per function. Uses the
 * sample/timeDelta stream when present (accurate), falling back to hitCounts.
 * V8 bookkeeping frames ((program), (garbage collector), (idle)) are dropped —
 * they are not actionable code.
 */
export function parseCpuProfile(profile: CpuProfile, topN = 12): { total: number; paths: HotPath[] } {
  const selfUs = new Map<number, number>();
  if (profile.samples?.length && profile.timeDeltas?.length) {
    for (let i = 0; i < profile.samples.length; i++) {
      const d = profile.timeDeltas[i] || 0;
      if (d > 0) { selfUs.set(profile.samples[i], (selfUs.get(profile.samples[i]) || 0) + d); }
    }
  } else {
    for (const n of profile.nodes) {
      if (n.hitCount) { selfUs.set(n.id, n.hitCount * 1000); } // ~1ms/sample fallback
    }
  }

  const byFn = new Map<string, HotPath>();
  let totalUs = 0;
  for (const n of profile.nodes) {
    const us = selfUs.get(n.id) || 0;
    if (us <= 0) { continue; }
    const fn = n.callFrame.functionName || '(anonymous)';
    if (/^\((program|garbage collector|idle|root)\)$/.test(fn)) { continue; }
    totalUs += us;
    const key = `${fn}@@${n.callFrame.url || ''}`;
    const cur = byFn.get(key);
    if (cur) { cur.selfMs += us / 1000; }
    else { byFn.set(key, { name: fn, file: shortUrl(n.callFrame.url || ''), selfMs: us / 1000, selfPct: 0 }); }
  }

  const paths = [...byFn.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, topN);
  for (const p of paths) { p.selfPct = totalUs > 0 ? (p.selfMs * 1000 / totalUs) * 100 : 0; }
  return { total: totalUs / 1000, paths };
}

export function renderHotPaths(total: number, paths: HotPath[]): string {
  if (!paths.length) {
    return 'PROFILE: no samples captured — the run was probably too short. Make the workload run ' +
      'for at least ~1 second (loop it) and profile again.';
  }
  const nameW = Math.min(44, Math.max(...paths.map(p => p.name.length), 10));
  const rows = paths.map(p =>
    `  ${p.name.slice(0, nameW).padEnd(nameW)}  ${p.selfPct.toFixed(1).padStart(5)}%  ` +
    `${p.selfMs.toFixed(1).padStart(8)} ms  ${p.file}`);
  return `HOT PATHS (self time, ${total.toFixed(0)} ms profiled — optimize the top of this list, ` +
    `not code that merely looks slow):\n${rows.join('\n')}`;
}

/** Python profiling harness: cProfile in-process, ranked JSON out. */
export function buildPythonProfileHarness(code: string, topN: number): string {
  return [
    'import cProfile, pstats, io, json',
    '_pr = cProfile.Profile()',
    '_pr.enable()',
    code,
    '_pr.disable()',
    '_st = pstats.Stats(_pr)',
    '_rows = []',
    '_total = 0.0',
    'for (_file, _line, _name), (_cc, _nc, _tt, _ct, _callers) in _st.stats.items():',
    '    _total += _tt',
    '    _rows.append({"name": _name, "file": f"{_file}:{_line}", "selfMs": _tt * 1000.0})',
    '_rows.sort(key=lambda r: -r["selfMs"])',
    `_rows = _rows[:${topN}]`,
    'for _r in _rows:',
    '    _r["selfPct"] = (_r["selfMs"] / (_total * 1000.0) * 100.0) if _total > 0 else 0.0',
    `print("${LAB_RESULT_PREFIX}" + json.dumps({"totalMs": _total * 1000.0, "paths": _rows}))`,
  ].join('\n');
}

// ── Observed scaling ─────────────────────────────────────────────

export interface ScalingSample { n: number; ms: number; }

export interface ScalingFit {
  best: string;                          // e.g. '~n log n'
  /** Relative residual of the best fit (0 = perfect). */
  residual: number;
  ranking: Array<{ model: string; residual: number }>;
  unreliable: boolean;
  note: string;
}

const MODELS: Array<{ name: string; f: (n: number) => number }> = [
  { name: 'constant', f: () => 1 },
  { name: 'log n', f: n => Math.log2(Math.max(2, n)) },
  { name: 'n', f: n => n },
  { name: 'n log n', f: n => n * Math.log2(Math.max(2, n)) },
  { name: 'n^2', f: n => n * n },
  { name: 'n^3', f: n => n * n * n },
];

/**
 * Fit each candidate curve by least-squares scale factor and rank by relative
 * RMS residual. Reported as OBSERVED scaling — the fit says which curve the
 * MEASURED points resemble, nothing more.
 */
export function fitScaling(samples: ScalingSample[]): ScalingFit {
  const valid = samples.filter(s => s.n > 0 && s.ms >= 0);
  if (valid.length < 3) {
    return {
      best: 'unknown', residual: 1, ranking: [], unreliable: true,
      note: 'need at least 3 sizes to say anything',
    };
  }
  const tiny = valid.every(s => s.ms < 0.05);
  const ranking = MODELS.map(m => {
    const xs = valid.map(s => m.f(s.n));
    const num = valid.reduce((acc, s, i) => acc + xs[i] * s.ms, 0);
    const den = valid.reduce((acc, _s, i) => acc + xs[i] * xs[i], 0);
    const k = den > 0 ? num / den : 0;
    const rms = Math.sqrt(valid.reduce((acc, s, i) => {
      const pred = k * xs[i];
      const scale = Math.max(s.ms, 1e-6);
      return acc + ((pred - s.ms) / scale) ** 2;
    }, 0) / valid.length);
    return { model: m.name, residual: rms };
  }).sort((a, b) => a.residual - b.residual);

  const best = ranking[0];
  const runnerUp = ranking[1];
  const ambiguous = runnerUp && runnerUp.residual < best.residual * 1.5;
  return {
    best: `~${best.model}`,
    residual: best.residual,
    ranking,
    unreliable: tiny || best.residual > 0.5,
    note: tiny
      ? 'timings are near timer resolution — increase the sizes or repeat counts'
      : ambiguous
        ? `close call with ~${runnerUp.model} — widen the size range to separate them`
        : 'fit is clear on the measured range',
  };
}

export function renderScalingFit(samples: ScalingSample[], fit: ScalingFit): string {
  const rows = samples.map(s => `  n=${s.n}  ${s.ms.toFixed(3)} ms`).join('\n');
  const head = `OBSERVED SCALING (measured, not proven): ${fit.best}` +
    (fit.unreliable ? ' — LOW CONFIDENCE' : '');
  return `${head}\n${rows}\n${fit.note}. This is a curve fit over ${samples.length} sizes on this ` +
    `machine; it suggests where to look, it does not prove asymptotic complexity.`;
}

/** Scaling harness: run `code` (which uses the variable n) at each size, median of `reps`. */
export function buildScalingHarness(
  lang: 'javascript' | 'python',
  setup: string,
  code: string,
  sizes: number[],
  reps: number
): string {
  const sizesLit = JSON.stringify(sizes);
  if (lang === 'python') {
    return [
      'import time, json, statistics',
      setup,
      `_out=[]`,
      `for n in ${sizesLit}:`,
      `    _ts=[]`,
      `    for _ in range(${reps}):`,
      `        _t0=time.perf_counter()`,
      `        ${code}`,
      `        _ts.append((time.perf_counter()-_t0)*1000.0)`,
      `    _out.append({"n": n, "ms": statistics.median(_ts)})`,
      `print("${LAB_RESULT_PREFIX}"+json.dumps({"samples":_out}))`,
    ].join('\n');
  }
  return [
    `const { performance } = require('perf_hooks');`,
    setup,
    `const _out = [];`,
    `for (const n of ${sizesLit}) {`,
    `  const _ts = [];`,
    `  for (let _r = 0; _r < ${reps}; _r++) {`,
    `    const _t0 = performance.now();`,
    `    ${code}`,
    `    _ts.push(performance.now() - _t0);`,
    `  }`,
    `  _ts.sort((a, b) => a - b);`,
    `  _out.push({ n, ms: _ts[Math.floor(_ts.length / 2)] });`,
    `}`,
    `console.log('${LAB_RESULT_PREFIX}' + JSON.stringify({ samples: _out }));`,
  ].join('\n');
}
