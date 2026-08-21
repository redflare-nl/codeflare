/**
 * The Lab — a disposable workspace under .codeflare/lab/ where the agent runs
 * controlled experiments WITHOUT touching production source: scratch scripts,
 * benchmarks, and old-vs-new differential tests.
 *
 * Isolation properties:
 *  - .codeflare/ is excluded from the repo map, file tools, and search, and
 *    carries a self-ignoring .gitignore — lab artifacts can never ship;
 *  - the ordinary write tools CANNOT write here (path policy forbids
 *    .codeflare/**) — the lab is only reachable through these bounded tools;
 *  - every run has a hard timeout and capped output; scripts run with the
 *    WORKSPACE as cwd so they can import the project's real modules.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { log } from '../utils/logger';
import {
  BenchStats,
  DiffStats,
  LabLanguage,
  buildBenchmarkHarness,
  buildDiffHarness,
  labRunner,
  parseLabResult,
  renderBenchStats,
  renderDiffStats,
} from './labHarness';
import {
  HotPath,
  ScalingSample,
  buildPythonProfileHarness,
  buildScalingHarness,
  fitScaling,
  parseCpuProfile,
  renderHotPaths,
  renderScalingFit,
} from './profiling';

const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 20_000;
const RETENTION_MS = 7 * 24 * 3600_000;

function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function normLang(raw: unknown): LabLanguage {
  const v = String(raw || '').toLowerCase();
  if (v === 'python' || v === 'py') { return 'python'; }
  if (v === 'powershell' || v === 'ps1' || v === 'pwsh') { return 'powershell'; }
  return 'javascript';
}

let labSeq = 0;

/** Write a harness into a fresh lab dir; returns its absolute path + rel dir. */
async function writeLabScript(lang: LabLanguage, code: string, name?: string):
  Promise<{ file: string; relDir: string } | { error: string }> {
  const root = workspaceRoot();
  if (!root) { return { error: 'No workspace folder is open.' }; }
  const slug = (String(name || 'experiment').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40) || 'experiment') +
    `-${Date.now()}-${++labSeq}`;
  const dir = vscode.Uri.joinPath(root, '.codeflare', 'lab', slug);
  const { ext } = labRunner(lang);
  const file = vscode.Uri.joinPath(dir, `main.${ext}`);
  try {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(code));
    // Belt-and-braces: keep everything under .codeflare/ out of version
    // control even when the probe sink never created the ignore file — lab
    // artifacts must not be able to ship.
    const ignore = vscode.Uri.joinPath(root, '.codeflare', '.gitignore');
    try { await vscode.workspace.fs.stat(ignore); }
    catch { await vscode.workspace.fs.writeFile(ignore, new TextEncoder().encode('*\n')); }
  } catch (err: any) {
    return { error: `Could not write the lab script: ${err.message}` };
  }
  void pruneOldLabDirs(root);
  return { file: file.fsPath, relDir: `.codeflare/lab/${slug}` };
}

/** Best-effort retention: drop lab dirs older than a week. */
async function pruneOldLabDirs(root: vscode.Uri): Promise<void> {
  try {
    const lab = vscode.Uri.joinPath(root, '.codeflare', 'lab');
    const entries = await vscode.workspace.fs.readDirectory(lab);
    const cutoff = Date.now() - RETENTION_MS;
    for (const [name, kind] of entries) {
      if (kind !== vscode.FileType.Directory) { continue; }
      const m = name.match(/-(\d{13})-\d+$/);
      if (m && parseInt(m[1], 10) < cutoff) {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(lab, name), { recursive: true });
      }
    }
  } catch { /* nothing to prune */ }
}

/** Execute a lab script with hard bounds. Never throws. */
function execLabScript(lang: LabLanguage, file: string, timeoutMs: number, extraArgv: string[] = []):
  Promise<{ ok: boolean; output: string }> {
  const root = workspaceRoot();
  const { argv } = labRunner(lang);
  const [cmd, ...restArgs] = argv(file);
  // Runtime flags (e.g. node --cpu-prof) go BEFORE the script path.
  const args = extraArgv.length ? [...extraArgv, ...restArgs] : restArgs;
  const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1000, timeoutMs || DEFAULT_TIMEOUT_MS));
  return new Promise(resolve => {
    execFile(cmd, args, {
      cwd: root?.fsPath, timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true,
    }, (err, stdout, stderr) => {
      const out = [
        String(stdout || '').slice(0, MAX_OUTPUT),
        String(stderr || '') ? `--- stderr ---\n${String(stderr).slice(0, MAX_OUTPUT)}` : '',
        err && (err as any).killed ? `--- TIMED OUT after ${timeout} ms (hard lab limit) ---` : '',
      ].filter(Boolean).join('\n');
      resolve({ ok: !err, output: out || '(no output)' });
    });
  });
}

/** lab_run: execute a scratch script in the lab. */
export async function labRunTool(args: {
  language?: string; code?: string; name?: string; timeout_ms?: number;
}): Promise<string> {
  const code = String(args.code || '');
  if (!code.trim()) { return 'lab_run needs "code" — the script to execute.'; }
  const lang = normLang(args.language);
  const w = await writeLabScript(lang, code, args.name);
  if ('error' in w) { return w.error; }
  const res = await execLabScript(lang, w.file, args.timeout_ms || DEFAULT_TIMEOUT_MS);
  log(`Lab run (${lang}) in ${w.relDir}: ${res.ok ? 'ok' : 'FAILED'}`);
  return `LAB RUN (${lang}, saved in ${w.relDir}) → ${res.ok ? 'exit code: 0' : 'FAILED'}\n${res.output}`;
}

/** lab_benchmark: measure `code` over N iterations (setup runs once). */
export async function labBenchmarkTool(args: {
  language?: string; setup?: string; code?: string; label?: string;
  iterations?: number; warmup?: number; timeout_ms?: number;
}): Promise<string> {
  const code = String(args.code || '');
  if (!code.trim()) { return 'lab_benchmark needs "code" — the statement to measure each iteration.'; }
  const lang = normLang(args.language);
  const iterations = Math.min(1_000_000, Math.max(1, Math.floor(args.iterations || 1000)));
  const warmup = Math.min(100_000, Math.max(0, Math.floor(args.warmup ?? Math.ceil(iterations / 10))));
  const harness = buildBenchmarkHarness(lang, String(args.setup || ''), code, iterations, warmup);
  const w = await writeLabScript(lang, harness, `bench-${args.label || 'fn'}`);
  if ('error' in w) { return w.error; }
  const res = await execLabScript(lang, w.file, args.timeout_ms || 60_000);
  const stats = parseLabResult<BenchStats>(res.output);
  if (!stats) {
    return `Benchmark harness failed (no result line). Raw output:\n${res.output}\n` +
      `Fix the setup/code (it must be valid ${lang}) and re-run. Harness saved in ${w.relDir}.`;
  }
  log(`Lab benchmark "${args.label || 'fn'}": mean ${stats.meanMs.toFixed(3)}ms over ${stats.iterations} iters`);
  return renderBenchStats(args.label || '(unlabelled)', stats) +
    `\n(harness saved in ${w.relDir}; timings are wall-clock on this machine — compare only against ` +
    `a baseline measured the same way)`;
}

/** lab_diff_test: run oldImpl vs newImpl against generated inputs. */
export async function labDiffTestTool(args: {
  language?: string; old_code?: string; new_code?: string; generator?: string;
  cases?: number; timeout_ms?: number;
}): Promise<string> {
  const oldCode = String(args.old_code || '');
  const newCode = String(args.new_code || '');
  const generator = String(args.generator || '');
  if (!oldCode.trim() || !newCode.trim() || !generator.trim()) {
    return 'lab_diff_test needs "old_code" (defines oldImpl/old_impl), "new_code" (defines ' +
      'newImpl/new_impl) and "generator" (defines gen(i) returning the input for case i).';
  }
  const lang = normLang(args.language);
  if (lang === 'powershell') { return 'lab_diff_test supports javascript and python.'; }
  const cases = Math.min(100_000, Math.max(1, Math.floor(args.cases || 1000)));
  const harness = buildDiffHarness(lang, oldCode, newCode, generator, cases);
  const w = await writeLabScript(lang, harness, 'diff-test');
  if ('error' in w) { return w.error; }
  const res = await execLabScript(lang, w.file, args.timeout_ms || 60_000);
  const stats = parseLabResult<DiffStats & { error?: string }>(res.output);
  if (!stats) {
    return `Differential harness failed (no result line). Raw output:\n${res.output}\n` +
      `Fix the code (it must be valid ${lang}) and re-run. Harness saved in ${w.relDir}.`;
  }
  if (stats.error) { return `Differential harness error: ${stats.error}`; }
  log(`Lab diff test: ${stats.identical}/${stats.cases} identical, ${stats.different} different, ${stats.errors} errors`);
  return renderDiffStats(stats) + `\n(harness saved in ${w.relDir})`;
}

/**
 * lab_profile: run a representative workload under a REAL profiler and return
 * a ranked hot-path report. Node via --cpu-prof; Python via in-process
 * cProfile. The raw profile stays on disk; only the ranking reaches context.
 */
export async function labProfileTool(args: {
  language?: string; code?: string; top?: number; timeout_ms?: number;
}): Promise<string> {
  const code = String(args.code || '');
  if (!code.trim()) {
    return 'lab_profile needs "code" — a script exercising a REPRESENTATIVE workload (loop the ' +
      'operation so the run lasts ≥1 second; a too-short run yields no samples).';
  }
  const lang = normLang(args.language);
  const topN = Math.min(30, Math.max(3, Math.floor(args.top || 12)));
  if (lang === 'python') {
    const harness = buildPythonProfileHarness(code, topN);
    const w = await writeLabScript('python', harness, 'profile');
    if ('error' in w) { return w.error; }
    const res = await execLabScript('python', w.file, args.timeout_ms || 60_000);
    const parsed = parseLabResult<{ totalMs: number; paths: HotPath[] }>(res.output);
    if (!parsed) {
      return `Profile harness failed (no result line). Raw output:\n${res.output}\nHarness saved in ${w.relDir}.`;
    }
    return renderHotPaths(parsed.totalMs, parsed.paths) + `\n(cProfile; harness saved in ${w.relDir})`;
  }
  if (lang === 'powershell') { return 'lab_profile supports javascript (node --cpu-prof) and python (cProfile).'; }

  const w = await writeLabScript('javascript', code, 'profile');
  if ('error' in w) { return w.error; }
  const profDir = path.dirname(w.file);
  const res = await execLabScript('javascript', w.file, args.timeout_ms || 60_000,
    ['--cpu-prof', `--cpu-prof-dir=${profDir}`, '--cpu-prof-name=profile.cpuprofile']);
  let profileJson: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(profDir, 'profile.cpuprofile')));
    profileJson = new TextDecoder().decode(bytes);
  } catch {
    return `The profiler produced no profile (script crashed before any samples?). Script output:\n${res.output}`;
  }
  try {
    const { total, paths } = parseCpuProfile(JSON.parse(profileJson), topN);
    log(`Lab profile: ${paths.length} hot path(s) over ${total.toFixed(0)}ms`);
    return renderHotPaths(total, paths) + `\n(V8 --cpu-prof; raw profile + harness saved in ${w.relDir})` +
      (res.ok ? '' : `\nNOTE — the script itself exited non-zero:\n${res.output.slice(0, 1500)}`);
  } catch (err: any) {
    return `Could not parse the CPU profile: ${err.message}`;
  }
}

/**
 * lab_scaling: measure `code` (which must use the variable n) at several
 * sizes and fit the OBSERVED scaling curve. Suggestive, never a proof.
 */
export async function labScalingTool(args: {
  language?: string; setup?: string; code?: string; sizes?: number[];
  reps?: number; timeout_ms?: number;
}): Promise<string> {
  const code = String(args.code || '');
  if (!code.trim()) {
    return 'lab_scaling needs "code" — a statement using the variable n (e.g. calling the function ' +
      'under test with an input of size n built in "setup" or inline).';
  }
  const lang = normLang(args.language);
  if (lang === 'powershell') { return 'lab_scaling supports javascript and python.'; }
  const sizes = (Array.isArray(args.sizes) && args.sizes.length >= 3
    ? args.sizes : [100, 200, 400, 800, 1600])
    .map(n => Math.max(1, Math.floor(n))).slice(0, 12);
  const reps = Math.min(50, Math.max(3, Math.floor(args.reps || 5)));
  const harness = buildScalingHarness(lang, String(args.setup || ''), code, sizes, reps);
  const w = await writeLabScript(lang, harness, 'scaling');
  if ('error' in w) { return w.error; }
  const res = await execLabScript(lang, w.file, args.timeout_ms || 90_000);
  const parsed = parseLabResult<{ samples: ScalingSample[] }>(res.output);
  if (!parsed) {
    return `Scaling harness failed (no result line). Raw output:\n${res.output}\nHarness saved in ${w.relDir}.`;
  }
  const fit = fitScaling(parsed.samples);
  log(`Lab scaling: best ${fit.best} (residual ${fit.residual.toFixed(3)})`);
  return renderScalingFit(parsed.samples, fit) + `\n(harness saved in ${w.relDir})`;
}
