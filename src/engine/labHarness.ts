/**
 * Harness builders for the Lab — the temporary, isolated workspace where the
 * agent EXPERIMENTS instead of guessing: run a scratch script, measure a
 * function, or execute old-vs-new implementations against generated inputs.
 *
 * Everything here is a pure string builder + output parser (unit-testable);
 * execution lives in lab.ts. Harnesses print ONE line starting with
 * CF_LAB_RESULT: followed by compact JSON — the parser ignores everything
 * else, so user code can print freely without corrupting the result.
 *
 * Honesty rules baked in:
 *  - timings are wall-clock; the JS heap delta is labelled an ESTIMATE
 *    (V8 gives no reliable per-call allocation count — we do not invent one);
 *  - differential results report counts + the SMALLEST failing inputs, never
 *    thousands of passing cases.
 */

export type LabLanguage = 'javascript' | 'python' | 'powershell';

export const LAB_RESULT_PREFIX = 'CF_LAB_RESULT:';

export interface BenchStats {
  iterations: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  errors: number;
  /** Node only; coarse heapUsed delta across the run — an ESTIMATE. */
  heapDeltaKb?: number;
}

export interface DiffStats {
  cases: number;
  identical: number;
  different: number;
  errors: number;
  /** Up to 3 mismatches, smallest inputs first (poor man's shrinking). */
  mismatches: Array<{ input: string; old: string; new: string }>;
}

/** File extension + runner argv for each lab language. */
export function labRunner(lang: LabLanguage): { ext: string; argv: (file: string) => string[] } {
  switch (lang) {
    case 'python': return { ext: 'py', argv: f => ['python', f] };
    case 'powershell': return {
      ext: 'ps1',
      argv: f => ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f],
    };
    default: return { ext: 'js', argv: f => ['node', f] };
  }
}

/** Percentile from a sorted array (nearest-rank). */
function pctExpr(lang: 'js' | 'py'): string {
  return lang === 'js'
    ? 'const pct=(s,p)=>s[Math.min(s.length-1,Math.ceil(p/100*s.length)-1)];'
    : 'pct=lambda s,p: s[min(len(s)-1, max(0, -(-int(p*len(s))//100)-1))]';
}

/**
 * Benchmark harness: `setup` runs once, `code` runs per iteration. Stats are
 * computed inside the harness and emitted as the CF_LAB_RESULT line.
 */
export function buildBenchmarkHarness(
  lang: LabLanguage,
  setup: string,
  code: string,
  iterations: number,
  warmup: number
): string {
  if (lang === 'python') {
    return [
      'import time, json',
      setup,
      `_samples=[]`,
      `_errors=0`,
      `for _ in range(${warmup}):`,
      `    try:`,
      `        ${code}`,
      `    except Exception:`,
      `        pass`,
      `for _ in range(${iterations}):`,
      `    _t0=time.perf_counter()`,
      `    try:`,
      `        ${code}`,
      `    except Exception:`,
      `        _errors+=1`,
      `    _samples.append((time.perf_counter()-_t0)*1000.0)`,
      `_samples.sort()`,
      pctExpr('py'),
      `print("${LAB_RESULT_PREFIX}"+json.dumps({`,
      `  "iterations": ${iterations},`,
      `  "meanMs": sum(_samples)/len(_samples),`,
      `  "p50Ms": pct(_samples,50), "p95Ms": pct(_samples,95), "p99Ms": pct(_samples,99),`,
      `  "maxMs": _samples[-1], "errors": _errors}))`,
    ].join('\n');
  }
  if (lang === 'powershell') {
    return [
      setup,
      `$_samples=@(); $_errors=0`,
      `for($i=0;$i -lt ${warmup};$i++){ try { ${code} } catch {} }`,
      `for($i=0;$i -lt ${iterations};$i++){`,
      `  $_sw=[System.Diagnostics.Stopwatch]::StartNew()`,
      `  try { ${code} } catch { $_errors++ }`,
      `  $_sw.Stop(); $_samples+=$_sw.Elapsed.TotalMilliseconds`,
      `}`,
      `$_samples=$_samples | Sort-Object`,
      `$pct={param($s,$p) $s[[Math]::Min($s.Count-1,[Math]::Max(0,[Math]::Ceiling($p/100*$s.Count)-1))]}`,
      `$r=@{iterations=${iterations};meanMs=($_samples | Measure-Object -Average).Average;`,
      `p50Ms=(& $pct $_samples 50);p95Ms=(& $pct $_samples 95);p99Ms=(& $pct $_samples 99);`,
      `maxMs=$_samples[-1];errors=$_errors}`,
      `Write-Output ("${LAB_RESULT_PREFIX}"+($r | ConvertTo-Json -Compress))`,
    ].join('\n');
  }
  return [
    `const { performance } = require('perf_hooks');`,
    setup,
    `const _samples = []; let _errors = 0;`,
    `for (let i = 0; i < ${warmup}; i++) { try { ${code} } catch (e) {} }`,
    `const _heap0 = process.memoryUsage().heapUsed;`,
    `for (let i = 0; i < ${iterations}; i++) {`,
    `  const _t0 = performance.now();`,
    `  try { ${code} } catch (e) { _errors++; }`,
    `  _samples.push(performance.now() - _t0);`,
    `}`,
    `const _heapDeltaKb = Math.round((process.memoryUsage().heapUsed - _heap0) / 1024);`,
    `_samples.sort((a, b) => a - b);`,
    pctExpr('js'),
    `console.log('${LAB_RESULT_PREFIX}' + JSON.stringify({`,
    `  iterations: ${iterations},`,
    `  meanMs: _samples.reduce((a, b) => a + b, 0) / _samples.length,`,
    `  p50Ms: pct(_samples, 50), p95Ms: pct(_samples, 95), p99Ms: pct(_samples, 99),`,
    `  maxMs: _samples[_samples.length - 1], errors: _errors, heapDeltaKb: _heapDeltaKb }));`,
  ].join('\n');
}

/**
 * Differential harness: `oldImpl`/`newImpl` (defined by old_code/new_code) run
 * against `gen(i)` inputs; outputs compared structurally. Only JS and Python —
 * the compare semantics need real data structures.
 */
export function buildDiffHarness(
  lang: LabLanguage,
  oldCode: string,
  newCode: string,
  generator: string,
  cases: number
): string {
  if (lang === 'python') {
    return [
      'import json, traceback',
      `_OLD_NS={}; _NEW_NS={}; _GEN_NS={}`,
      `exec(${JSON.stringify(oldCode)}, _OLD_NS)`,
      `exec(${JSON.stringify(newCode)}, _NEW_NS)`,
      `exec(${JSON.stringify(generator)}, _GEN_NS)`,
      `_old=_OLD_NS.get("old_impl") or _OLD_NS.get("oldImpl")`,
      `_new=_NEW_NS.get("new_impl") or _NEW_NS.get("newImpl")`,
      `_gen=_GEN_NS.get("gen")`,
      `assert _old and _new and _gen, "old_code must define old_impl, new_code new_impl, generator gen(i)"`,
      `_ident=0; _diff=0; _errs=0; _mm=[]`,
      `def _ser(v):`,
      `    try: return json.dumps(v, sort_keys=True, default=repr)`,
      `    except Exception: return repr(v)`,
      `for _i in range(${cases}):`,
      `    try:`,
      `        _inp=_gen(_i)`,
      `        _a=_ser(_old(_inp)); _b=_ser(_new(_inp))`,
      `        if _a==_b: _ident+=1`,
      `        else:`,
      `            _diff+=1`,
      `            _mm.append({"input":_ser(_inp)[:400],"old":_a[:200],"new":_b[:200]})`,
      `    except Exception:`,
      `        _errs+=1`,
      `_mm.sort(key=lambda m: len(m["input"]))`,
      `print("${LAB_RESULT_PREFIX}"+json.dumps({"cases":${cases},"identical":_ident,` +
        `"different":_diff,"errors":_errs,"mismatches":_mm[:3]}))`,
    ].join('\n');
  }
  return [
    oldCode,
    `const __old = typeof oldImpl === 'function' ? oldImpl : undefined;`,
    `(() => {})();`,
    newCode,
    `const __new = typeof newImpl === 'function' ? newImpl : undefined;`,
    generator,
    `const __gen = typeof gen === 'function' ? gen : undefined;`,
    `if (!__old || !__new || !__gen) {`,
    `  console.log('${LAB_RESULT_PREFIX}' + JSON.stringify({ error: 'old_code must define function oldImpl, new_code function newImpl, generator function gen(i)' }));`,
    `  process.exit(1);`,
    `}`,
    `const _ser = v => { try { return JSON.stringify(v, (k, x) => typeof x === 'undefined' ? '__undefined__' : x); } catch (e) { return String(v); } };`,
    `let _ident = 0, _diff = 0, _errs = 0; const _mm = [];`,
    `for (let _i = 0; _i < ${cases}; _i++) {`,
    `  try {`,
    `    const _inp = __gen(_i);`,
    `    const _a = _ser(__old(_inp)); const _b = _ser(__new(_inp));`,
    `    if (_a === _b) { _ident++; }`,
    `    else { _diff++; _mm.push({ input: _ser(_inp).slice(0, 400), old: String(_a).slice(0, 200), new: String(_b).slice(0, 200) }); }`,
    `  } catch (e) { _errs++; }`,
    `}`,
    `_mm.sort((a, b) => a.input.length - b.input.length);`,
    `console.log('${LAB_RESULT_PREFIX}' + JSON.stringify({ cases: ${cases}, identical: _ident, different: _diff, errors: _errs, mismatches: _mm.slice(0, 3) }));`,
  ].join('\n');
}

/** Extract the CF_LAB_RESULT payload from harness output. */
export function parseLabResult<T>(output: string): T | undefined {
  const line = output.split('\n').map(l => l.trim()).reverse()
    .find(l => l.startsWith(LAB_RESULT_PREFIX));
  if (!line) { return undefined; }
  try { return JSON.parse(line.slice(LAB_RESULT_PREFIX.length)) as T; }
  catch { return undefined; }
}

const fmt = (n: number) => n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(4);

/** Human summary of a benchmark run — exact numbers, estimates labelled. */
export function renderBenchStats(label: string, s: BenchStats): string {
  const lines = [
    `BENCHMARK ${label} (${s.iterations} iterations)`,
    `  mean ${fmt(s.meanMs)} ms · p50 ${fmt(s.p50Ms)} ms · p95 ${fmt(s.p95Ms)} ms · ` +
      `p99 ${fmt(s.p99Ms)} ms · max ${fmt(s.maxMs)} ms`,
    `  errors: ${s.errors}`,
  ];
  if (typeof s.heapDeltaKb === 'number') {
    lines.push(`  heap delta: ~${s.heapDeltaKb} KB across the run (ESTIMATE — coarse process-level measure, not per-call allocations)`);
  }
  return lines.join('\n');
}

/** Human summary of a differential run — counts + smallest failing inputs. */
export function renderDiffStats(s: DiffStats): string {
  const head = `DIFFERENTIAL TEST: ${s.cases} case(s) → ${s.identical} identical, ` +
    `${s.different} different, ${s.errors} error(s)`;
  if (s.different === 0 && s.errors === 0) {
    return `${head}\nNo behavioural difference observed on these inputs. (This supports — but ` +
      `cannot prove — equivalence; coverage is only as good as the generator.)`;
  }
  const mm = s.mismatches.map((m, i) =>
    `  #${i + 1} input=${m.input}\n     old → ${m.old}\n     new → ${m.new}`).join('\n');
  return `${head}\nSmallest mismatching input(s):\n${mm}\nFix the difference (or justify it), then re-run.`;
}
