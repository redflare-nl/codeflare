import * as vscode from 'vscode';
import { log } from '../utils/logger';
import { discoveredPath } from '../utils/executables';

/**
 * Stack / capability detection. A repository is NOT one project type — it can
 * mix a Java/Maven backend, a TS/npm frontend and PowerShell scripts. So this
 * scans PER directory/module: it finds marker files (package.json, pom.xml,
 * project.godot, …), groups them by the directory that owns them, and derives
 * the build/typecheck/lint/test/run tasks for each — sourced from what the
 * project ITSELF already uses (package.json scripts, a gradle wrapper, a
 * lockfile's package manager) rather than a strategy we invent.
 *
 * The result feeds two consumers: a compact prompt block (so the model knows
 * what the repo is and how to verify each part) and the verify gate (which runs
 * the cheapest sound check for the module that changed). The plugin only OFFERS
 * these capabilities; the model decides which to run and when.
 */

export type StackKind =
  | 'node' | 'python' | 'godot' | 'dotnet' | 'java' | 'powershell'
  | 'cmake' | 'make' | 'go' | 'rust' | 'web';

export type TaskKind = 'syntax' | 'typecheck' | 'lint' | 'test' | 'build' | 'run';

export interface StackTask {
  kind: TaskKind;
  command: string;
  // Where the command came from, so provenance is visible ("package.json script
  // 'test'", "gradle wrapper", "convention"). The model can weigh a
  // project-defined task above a conventional guess.
  source: string;
}

export interface DetectedStack {
  kind: StackKind;
  label: string;
  root: string;         // workspace-relative dir that owns this module ('.' = root)
  markers: string[];    // marker files found there
  packageManager?: string;
  tasks: StackTask[];   // ordered cheapest-first (syntax/typecheck → lint → test → build)
  // How sure we are this is a REAL module vs. a stray file of that type (an
  // empty package.json, a lone index.html). 'low' = treat with suspicion.
  // Undefined is treated as 'high'. Surfaced to the model so it can tell the two
  // apart; it does NOT change what the verify gate offers.
  confidence?: 'high' | 'low';
  confidenceNote?: string;
}

const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,' +
  '**/.codeflare-trash/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/coverage/**,**/bin/**,**/obj/**,**/target/**}';

const isWin = process.platform === 'win32';

// ── small fs helpers ─────────────────────────────────────────────
function root(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}
function relDir(uri: vscode.Uri): string {
  const rel = vscode.workspace.asRelativePath(uri).replace(/\\/g, '/');
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  return dir || '.';
}
async function readText(dir: string, name: string): Promise<string | undefined> {
  const r = root();
  if (!r) { return undefined; }
  try {
    const uri = vscode.Uri.joinPath(r, ...(dir === '.' ? [] : dir.split('/')), name);
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch { return undefined; }
}
async function exists(dir: string, name: string): Promise<boolean> {
  const r = root();
  if (!r) { return false; }
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(r, ...(dir === '.' ? [] : dir.split('/')), name));
    return true;
  } catch { return false; }
}
async function firstExisting(dir: string, names: string[]): Promise<string | undefined> {
  for (const n of names) { if (await exists(dir, n)) { return n; } }
  return undefined;
}

// ── per-stack task builders ──────────────────────────────────────

async function nodeStack(dir: string): Promise<DetectedStack | undefined> {
  const pkgText = await readText(dir, 'package.json');
  if (!pkgText) { return undefined; }
  let scripts: Record<string, string> = {};
  let hasDeps = false;
  try {
    const pkg = JSON.parse(pkgText);
    scripts = pkg.scripts || {};
    hasDeps = Object.keys(pkg.dependencies || {}).length > 0 || Object.keys(pkg.devDependencies || {}).length > 0;
  } catch { /* malformed */ }

  const hasLock = (await exists(dir, 'pnpm-lock.yaml')) || (await exists(dir, 'yarn.lock')) ||
    (await exists(dir, 'bun.lockb')) || (await exists(dir, 'package-lock.json'));
  const pm = (await exists(dir, 'pnpm-lock.yaml')) ? 'pnpm'
    : (await exists(dir, 'yarn.lock')) ? 'yarn'
    : (await exists(dir, 'bun.lockb')) ? 'bun' : 'npm';
  const run = (script: string) => pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`;
  const tasks: StackTask[] = [];

  const hasTsconfig = await exists(dir, 'tsconfig.json');
  if (scripts.typecheck) { tasks.push({ kind: 'typecheck', command: run('typecheck'), source: `package.json script 'typecheck'` }); }
  else if (scripts['type-check']) { tasks.push({ kind: 'typecheck', command: run('type-check'), source: `package.json script 'type-check'` }); }
  else if (hasTsconfig) { tasks.push({ kind: 'typecheck', command: 'npx tsc --noEmit', source: 'tsconfig.json (convention)' }); }
  if (scripts.lint) { tasks.push({ kind: 'lint', command: run('lint'), source: `package.json script 'lint'` }); }
  if (scripts.test) { tasks.push({ kind: 'test', command: run('test'), source: `package.json script 'test'` }); }
  if (scripts.build) { tasks.push({ kind: 'build', command: run('build'), source: `package.json script 'build'` }); }
  for (const r of ['dev', 'start', 'serve']) {
    if (scripts[r]) { tasks.push({ kind: 'run', command: run(r), source: `package.json script '${r}'` }); break; }
  }

  // A package.json with no scripts, no deps, no lockfile and no tsconfig is
  // almost certainly metadata (a config shim, a publish stub) — not a buildable
  // module. Flag it low so a monorepo scan doesn't over-claim a Node module.
  const real = Object.keys(scripts).length > 0 || hasDeps || hasLock || hasTsconfig;
  return {
    kind: 'node', label: hasTsconfig ? 'Node/TypeScript' : 'Node.js', root: dir,
    markers: ['package.json'], packageManager: pm, tasks,
    confidence: real ? 'high' : 'low',
    ...(real ? {} : { confidenceNote: 'package.json has no scripts/deps/lockfile — may be metadata, not a real module' }),
  };
}

async function pythonStack(dir: string, markers: string[]): Promise<DetectedStack> {
  const pyproject = await readText(dir, 'pyproject.toml');
  const tasks: StackTask[] = [];
  // Cheap always-available soundness check: compile every module.
  tasks.push({ kind: 'syntax', command: `python -m compileall -q "${dir === '.' ? '.' : dir}"`, source: 'python -m compileall (built-in)' });
  const usesPytest = (pyproject && /\[tool\.pytest/.test(pyproject)) || await exists(dir, 'pytest.ini') ||
    await exists(dir, 'tox.ini') || await exists(dir, 'conftest.py');
  if (usesPytest) { tasks.push({ kind: 'test', command: 'python -m pytest', source: 'pytest config' }); }
  else { tasks.push({ kind: 'test', command: 'python -m unittest discover', source: 'convention (no pytest config found)' }); }
  if (pyproject && /\[tool\.mypy/.test(pyproject)) { tasks.push({ kind: 'typecheck', command: 'python -m mypy .', source: 'pyproject [tool.mypy]' }); }
  if (pyproject && /\bruff\b/.test(pyproject) || await exists(dir, 'ruff.toml')) { tasks.push({ kind: 'lint', command: 'python -m ruff check .', source: 'ruff config' }); }
  else if (pyproject && /\[tool\.flake8/.test(pyproject) || await exists(dir, '.flake8')) { tasks.push({ kind: 'lint', command: 'python -m flake8', source: 'flake8 config' }); }
  return { kind: 'python', label: 'Python', root: dir, markers, tasks };
}

async function godotStack(dir: string): Promise<DetectedStack> {
  const tasks: StackTask[] = [];
  // The Godot binary is rarely on PATH as "godot" — it's usually a versioned
  // exe found via find_executable. Use the discovered path when one is known.
  const found = discoveredPath('godot');
  const godot = found ? `"${found}"` : 'godot';
  const src = found ? `discovered binary (${found})` : 'convention; if godot is not on PATH, find_executable("godot") first';
  // GDScript parse check without opening the editor: a headless --import loads
  // every script and surfaces parse errors, then exits. (--check-only only
  // works with an explicit --script <file>, not project-wide.)
  tasks.push({
    kind: 'syntax',
    command: `${godot} --headless --path "${dir === '.' ? '.' : dir}" --import`,
    source: `Godot headless import (${src})`,
  });
  // GUT (Godot Unit Test) if the addon is present.
  if (await exists(dir, 'addons/gut')) {
    tasks.push({
      kind: 'test',
      command: `${godot} --headless --path "${dir === '.' ? '.' : dir}" -s addons/gut/gut_cmdln.gd -gexit`,
      source: 'GUT addon detected',
    });
  }
  return { kind: 'godot', label: 'Godot / GDScript', root: dir, markers: ['project.godot'], tasks };
}

async function dotnetStack(dir: string, marker: string): Promise<DetectedStack> {
  const tasks: StackTask[] = [
    { kind: 'build', command: 'dotnet build', source: '.NET SDK (convention)' },
    { kind: 'test', command: 'dotnet test', source: '.NET SDK (convention)' },
  ];
  return { kind: 'dotnet', label: '.NET', root: dir, markers: [marker], tasks };
}

async function javaStack(dir: string): Promise<DetectedStack | undefined> {
  const maven = await exists(dir, 'pom.xml');
  const gradle = await firstExisting(dir, ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']);
  if (!maven && !gradle) { return undefined; }
  const tasks: StackTask[] = [];
  if (maven) {
    const mvnw = await firstExisting(dir, isWin ? ['mvnw.cmd', 'mvnw'] : ['mvnw']);
    const mvn = mvnw ? (isWin ? '.\\mvnw.cmd' : './mvnw') : 'mvn';
    tasks.push({ kind: 'build', command: `${mvn} -q -DskipTests compile`, source: mvnw ? 'Maven wrapper' : 'mvn (PATH)' });
    tasks.push({ kind: 'test', command: `${mvn} -q test`, source: mvnw ? 'Maven wrapper' : 'mvn (PATH)' });
    return { kind: 'java', label: 'Java / Maven', root: dir, markers: ['pom.xml'], packageManager: 'maven', tasks };
  }
  const gw = await firstExisting(dir, isWin ? ['gradlew.bat', 'gradlew'] : ['gradlew']);
  const g = gw ? (isWin ? '.\\gradlew.bat' : './gradlew') : 'gradle';
  tasks.push({ kind: 'build', command: `${g} compileJava`, source: gw ? 'Gradle wrapper' : 'gradle (PATH)' });
  tasks.push({ kind: 'test', command: `${g} test`, source: gw ? 'Gradle wrapper' : 'gradle (PATH)' });
  return { kind: 'java', label: 'Java / Gradle', root: dir, markers: [gradle!], packageManager: 'gradle', tasks };
}

async function powershellStack(dir: string, markers: string[]): Promise<DetectedStack> {
  const tasks: StackTask[] = [];
  // Parser check for every .ps1/.psm1 in the dir (fast, no extra tools).
  tasks.push({
    kind: 'syntax',
    command: `Get-ChildItem -Path "${dir === '.' ? '.' : dir}" -Recurse -Include *.ps1,*.psm1 | ForEach-Object { $e=$null; [void][System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw $_.FullName),[ref]$e); if($e){ "$($_.Name): $($e.Count) parse error(s)"; $e } }`,
    source: 'PSParser tokenize (built-in)',
  });
  tasks.push({ kind: 'lint', command: `Invoke-ScriptAnalyzer -Path "${dir === '.' ? '.' : dir}" -Recurse`, source: 'PSScriptAnalyzer (if installed)' });
  // A module manifest (.psd1/.psm1) or a Pester test file means a real project;
  // otherwise it's loose scripts that happen to live here.
  const strong = markers.some(m => /\.psd1$/i.test(m) || /\.psm1$/i.test(m) || /\.Tests\.ps1$/i.test(m));
  return {
    kind: 'powershell', label: 'PowerShell', root: dir, markers, tasks,
    confidence: strong ? 'high' : 'low',
    ...(strong ? {} : { confidenceNote: 'loose .ps1 scripts, no module manifest or tests — may not be a real module' }),
  };
}

async function cmakeStack(dir: string): Promise<DetectedStack> {
  return {
    kind: 'cmake', label: 'C/C++ (CMake)', root: dir, markers: ['CMakeLists.txt'],
    tasks: [
      { kind: 'build', command: `cmake -S "${dir === '.' ? '.' : dir}" -B "${dir === '.' ? 'build' : dir + '/build'}" && cmake --build "${dir === '.' ? 'build' : dir + '/build'}"`, source: 'CMake (convention)' },
      { kind: 'test', command: `ctest --test-dir "${dir === '.' ? 'build' : dir + '/build'}"`, source: 'CTest (convention)' },
    ],
  };
}
function makeStack(dir: string): DetectedStack {
  return {
    kind: 'make', label: 'Make', root: dir, markers: ['Makefile'],
    tasks: [
      { kind: 'build', command: 'make', source: 'Makefile' },
      { kind: 'test', command: 'make test', source: 'Makefile (if a test target exists)' },
    ],
  };
}
function goStack(dir: string): DetectedStack {
  return {
    kind: 'go', label: 'Go', root: dir, markers: ['go.mod'],
    tasks: [
      { kind: 'build', command: 'go build ./...', source: 'go toolchain' },
      { kind: 'lint', command: 'go vet ./...', source: 'go toolchain' },
      { kind: 'test', command: 'go test ./...', source: 'go toolchain' },
    ],
  };
}
function rustStack(dir: string): DetectedStack {
  return {
    kind: 'rust', label: 'Rust', root: dir, markers: ['Cargo.toml'],
    tasks: [
      { kind: 'build', command: 'cargo build', source: 'cargo' },
      { kind: 'lint', command: 'cargo clippy', source: 'cargo (if clippy installed)' },
      { kind: 'test', command: 'cargo test', source: 'cargo' },
    ],
  };
}

// ── detection driver ─────────────────────────────────────────────

let cache: DetectedStack[] | undefined;
let dirty = true;

export function invalidateStacks(): void { dirty = true; }

async function findDirs(glob: string, cap = 40): Promise<string[]> {
  const hits = await vscode.workspace.findFiles(glob, EXCLUDE, cap);
  return [...new Set(hits.map(relDir))];
}

async function detect(): Promise<DetectedStack[]> {
  if (!root()) { return []; }
  const stacks: DetectedStack[] = [];
  const push = (s: DetectedStack | undefined) => { if (s) { stacks.push(s); } };

  // node
  for (const dir of await findDirs('**/package.json')) { push(await nodeStack(dir)); }
  // python (any of several markers → one stack per dir)
  const pyDirs = new Map<string, string[]>();
  for (const g of ['**/pyproject.toml', '**/requirements*.txt', '**/setup.py', '**/setup.cfg']) {
    for (const dir of await findDirs(g)) { pyDirs.set(dir, [...(pyDirs.get(dir) || []), g.split('/').pop()!]); }
  }
  for (const [dir, markers] of pyDirs) { push(await pythonStack(dir, markers)); }
  // godot
  for (const dir of await findDirs('**/project.godot')) { push(await godotStack(dir)); }
  // dotnet (sln preferred, else csproj)
  for (const dir of await findDirs('**/*.sln')) { push(await dotnetStack(dir, '*.sln')); }
  const slnDirs = new Set(stacks.filter(s => s.kind === 'dotnet').map(s => s.root));
  for (const dir of await findDirs('**/*.csproj')) { if (!slnDirs.has(dir)) { push(await dotnetStack(dir, '*.csproj')); } }
  // java (maven or gradle)
  const javaDirs = new Set<string>();
  for (const g of ['**/pom.xml', '**/build.gradle', '**/build.gradle.kts']) {
    for (const dir of await findDirs(g)) { javaDirs.add(dir); }
  }
  for (const dir of javaDirs) { push(await javaStack(dir)); }
  // powershell (module manifests / test files)
  const psDirs = new Map<string, string[]>();
  for (const g of ['**/*.psd1', '**/*.psm1', '**/*.Tests.ps1']) {
    for (const dir of await findDirs(g)) { psDirs.set(dir, [...(psDirs.get(dir) || []), g.split('/').pop()!]); }
  }
  for (const [dir, markers] of psDirs) { push(await powershellStack(dir, markers)); }
  // native / other
  for (const dir of await findDirs('**/CMakeLists.txt')) { push(await cmakeStack(dir)); }
  const cmakeDirs = new Set(stacks.filter(s => s.kind === 'cmake').map(s => s.root));
  for (const dir of await findDirs('**/Makefile')) { if (!cmakeDirs.has(dir)) { push(makeStack(dir)); } }
  for (const dir of await findDirs('**/go.mod')) { push(goStack(dir)); }
  for (const dir of await findDirs('**/Cargo.toml')) { push(rustStack(dir)); }
  // static web: an index.html whose dir has no package.json (else it's the node stack's)
  const nodeDirs = new Set(stacks.filter(s => s.kind === 'node').map(s => s.root));
  for (const dir of await findDirs('**/index.html')) {
    if (!nodeDirs.has(dir) && !(await exists(dir, 'package.json'))) {
      // A lone index.html is a weak signal — could be a coverage report, a
      // template, or a doc export rather than an app to serve.
      stacks.push({ kind: 'web', label: 'Static web (HTML/CSS/JS)', root: dir, markers: ['index.html'],
        tasks: [{ kind: 'run', command: `python -m http.server 8080`, source: 'convention (serve the folder)' }],
        confidence: 'low', confidenceNote: 'a lone index.html — verify it is an app, not a report/template' });
    }
  }

  // Shallowest roots first, then by kind, for stable output.
  stacks.sort((a, b) => a.root.split('/').length - b.root.split('/').length || a.root.localeCompare(b.root));
  log(`Stack detection: ${stacks.length} stack(s) — ${stacks.map(s => `${s.kind}@${s.root}`).join(', ') || 'none'}`);
  return stacks;
}

/** Detected stacks, cached; rebuilds when marked dirty. Never throws. */
export async function getStacks(): Promise<DetectedStack[]> {
  if (cache && !dirty) { return cache; }
  try {
    cache = await detect();
    dirty = false;
  } catch (err: any) {
    log(`Stack detection failed: ${err.message}`);
    cache = [];
  }
  return cache;
}

/** The stack that owns a given workspace-relative file: the deepest root that is a prefix. */
export function stackForPath(stacks: DetectedStack[], relPath: string): DetectedStack | undefined {
  // Windows' filesystem is case-insensitive, and the changed set is built from
  // the model's raw path strings — which may differ in casing from the detected
  // root. Compare case-insensitively there, or a differently-cased path (e.g.
  // "Src/app.ts" vs root "src") is attributed to no stack and its verify step is
  // silently skipped. POSIX stays case-sensitive (its filesystem is).
  const ci = process.platform === 'win32';
  const p = (raw => ci ? raw.toLowerCase() : raw)(relPath.replace(/\\/g, '/'));
  let best: DetectedStack | undefined;
  for (const s of stacks) {
    const baseRaw = s.root === '.' ? '' : s.root + '/';
    const base = ci ? baseRaw.toLowerCase() : baseRaw;
    if (base === '' || p.startsWith(base)) {
      if (!best || s.root.length > best.root.length) { best = s; }
    }
  }
  return best;
}

// Auto-gate task priority: the cheapest SOUND check, never a test/lint/run
// (those the model orchestrates itself via project_stacks + run_command).
const GATE_PRIORITY: TaskKind[] = ['typecheck', 'syntax', 'build'];

export interface VerifyStep { label: string; root: string; command: string; source: string; kind: TaskKind; }

/**
 * The verification step to auto-run for each stack that owns a changed file —
 * one cheapest-sound check per affected module, so a repo-wide edit verifies
 * every touched part, not one global command. Heavy steps (test) are left for
 * the model to trigger deliberately.
 */
export async function verifyStepsForChanges(changed: string[]): Promise<VerifyStep[]> {
  const stacks = await getStacks();
  if (stacks.length === 0 || changed.length === 0) { return []; }
  const affected = new Set<DetectedStack>();
  for (const p of changed) { const s = stackForPath(stacks, p); if (s) { affected.add(s); } }

  const steps: VerifyStep[] = [];
  for (const s of affected) {
    // For JS/TS and static web, the LSP diagnostics + tsc typecheck already
    // cover soundness — don't auto-run a (potentially slow) bundling build.
    const priority = (s.kind === 'node' || s.kind === 'web')
      ? GATE_PRIORITY.filter(k => k !== 'build')
      : GATE_PRIORITY;
    let chosen: StackTask | undefined;
    for (const k of priority) { chosen = s.tasks.find(t => t.kind === k); if (chosen) { break; } }
    if (chosen) { steps.push({ label: s.label, root: s.root, command: chosen.command, source: chosen.source, kind: chosen.kind }); }
  }
  return steps;
}

/** Detailed, provenance-annotated report of all stacks for the project_stacks tool. */
export function stacksToolReport(stacks: DetectedStack[]): string {
  if (stacks.length === 0) {
    return 'No known stack detected in this workspace. Inspect the files yourself to decide how to build/test.';
  }
  const out: string[] = [`Detected ${stacks.length} stack(s). Use these commands (from the project's own config) to build/verify each part; a repo can mix stacks, so pick the one that owns the files you changed:`];
  for (const s of stacks) {
    const weak = s.confidence === 'low' ? `  ⚠ LOW confidence: ${s.confidenceNote || 'possibly a stray file, not a real module'} — confirm before relying on these tasks.` : '';
    out.push(`\n${s.label} @ ${s.root}${s.packageManager ? ` — ${s.packageManager}` : ''} [markers: ${s.markers.join(', ')}]${weak}`);
    if (s.tasks.length === 0) { out.push('  (no tasks derived — inspect the project)'); }
    for (const t of s.tasks) { out.push(`  ${t.kind}: ${t.command}   (${t.source})`); }
  }
  return out.join('\n');
}

/** Compact prompt block describing the detected stacks and their tasks, or ''. */
export function stacksPromptBlock(stacks: DetectedStack[]): string {
  if (stacks.length === 0) { return ''; }
  const lines = stacks.slice(0, 12).map(s => {
    const tasks = s.tasks.map(t => `${t.kind}: ${t.command}`).join(' | ');
    const weak = s.confidence === 'low' ? ` [low confidence — likely a stray file, not a real module: ${s.confidenceNote || ''}]` : '';
    return `- ${s.label} @ ${s.root}${s.packageManager ? ` (${s.packageManager})` : ''}${weak}${tasks ? ` — ${tasks}` : ''}`;
  });
  return lines.join('\n');
}
