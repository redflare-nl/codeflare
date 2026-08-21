import * as vscode from 'vscode';
import * as path from 'path';
import { log } from '../utils/logger';
import { getConfig } from '../utils/config';
import { resolveInWorkspace, getTerminalLogLines } from '../llm/tools';
import { recordPreMutation } from './checkpoint';
import { previewMutation } from '../engine/policyGate';
import { policyMessage } from '../engine/policy';

/**
 * Probes — temporary instrumentation the agent writes INTO the code to measure
 * something it cannot read statically (how often a branch runs, what a value
 * actually holds at runtime, how long a loop takes), then reads back and acts on.
 *
 * Every probe is a single self-contained line ending in a sentinel marker
 * (`<comment> codeflare:probe p3`), so removal is an exact, whitespace-safe
 * line match — no diffing, no leftovers. A probe writes to BOTH:
 *   - stdout, prefixed `[[CF-PROBE:<id>]]` — visible in run_command output and
 *     in the persistent CodeFlare terminal (servers, watchers);
 *   - `.codeflare/probes.jsonl` in the workspace root — so a process whose
 *     output the agent never sees (a detached server, a game window) still
 *     reports back.
 *
 * Probes are meant to live for one measurement, not to be committed: unless
 * `codeflare.probeAutoStrip` is turned off, every one of them is removed again
 * at the end of the turn that placed it.
 */

export type ProbeKind = 'value' | 'hit' | 'custom';

interface ProbeRecord {
  id: string;
  relPath: string;
  label: string;
  kind: ProbeKind;
  expression?: string;
}

// Probes placed in this session, in insertion order. Auto-strip works off this
// registry (cheap); listProbes() additionally scans the workspace for orphans
// left behind by a previous window.
const registry = new Map<string, ProbeRecord>();
let nextId = 1;

const MAX_ACTIVE_PROBES = 40;
const MARKER_RE = /codeflare:probe\s+(p\d+)\s*$/;

// ---------------------------------------------------------------------------
// Language support
// ---------------------------------------------------------------------------

type Lang =
  | 'python' | 'js' | 'gdscript' | 'powershell' | 'shell'
  | 'java' | 'csharp' | 'go' | 'rust' | 'cpp' | 'php' | 'ruby' | 'lua';

const EXT_LANG: Record<string, Lang> = {
  '.py': 'python',
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js',
  '.gd': 'gdscript',
  '.ps1': 'powershell', '.psm1': 'powershell',
  '.sh': 'shell', '.bash': 'shell',
  '.java': 'java', '.cs': 'csharp', '.go': 'go', '.rs': 'rust',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.h': 'cpp',
  '.php': 'php', '.rb': 'ruby', '.lua': 'lua',
};

const COMMENT: Record<Lang, string> = {
  python: '#', js: '//', gdscript: '#', powershell: '#', shell: '#',
  java: '//', csharp: '//', go: '//', rust: '//', cpp: '//', php: '//',
  ruby: '#', lua: '--',
};

// Languages that can append to the sink file with a dependency-free one-liner.
// The rest print to stdout only — still useful, just invisible to a detached run.
const SINK_LANGS = new Set<Lang>(['python', 'js', 'gdscript', 'powershell', 'shell']);

function langOf(relPath: string): Lang | undefined {
  return EXT_LANG[path.extname(relPath).toLowerCase()];
}

/** Comment token for a file, defaulting to `#` for unknown text formats. */
function commentToken(relPath: string): string {
  const lang = langOf(relPath);
  return lang ? COMMENT[lang] : '#';
}

// ---------------------------------------------------------------------------
// Sink file
// ---------------------------------------------------------------------------

function sinkUri(): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  return root ? vscode.Uri.joinPath(root, '.codeflare', 'probes.jsonl') : undefined;
}

/** Absolute sink path with forward slashes — safe to embed in a code literal. */
function sinkLiteral(): string {
  const uri = sinkUri();
  return uri ? uri.fsPath.replace(/\\/g, '/') : '';
}

/**
 * Make sure `.codeflare/` exists, holds an empty sink file, and ignores itself
 * in git. The sink must EXIST before the first probe fires: GDScript's
 * FileAccess.READ_WRITE cannot create a missing file.
 */
async function ensureSink(): Promise<void> {
  const uri = sinkUri();
  if (!uri) { return; }
  const dir = vscode.Uri.joinPath(uri, '..');
  await vscode.workspace.fs.createDirectory(dir);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(''));
  }
  // Self-ignoring folder — instrumentation output never reaches a commit, and
  // the user's own .gitignore stays untouched.
  const ignore = vscode.Uri.joinPath(dir, '.gitignore');
  try {
    await vscode.workspace.fs.stat(ignore);
  } catch {
    await vscode.workspace.fs.writeFile(ignore, new TextEncoder().encode('*\n'));
  }
}

// ---------------------------------------------------------------------------
// Snippet emitters
// ---------------------------------------------------------------------------

/** Strip anything that would break out of the string literal we embed it in. */
function safeLabel(label: string): string {
  return (label || 'probe').replace(/["'`\\\r\n]/g, ' ').slice(0, 60).trim() || 'probe';
}

/**
 * Build the probe body for a language, as lines WITHOUT the trailing marker
 * (the caller marks every line, so removal stays a plain per-line match).
 *
 * Two rules hold for every emitter: a failing sink write must never take the
 * user's program down with it, and a failing EXPRESSION must stay loud — a
 * silently swallowed typo would show up as "probe never hit", which reads as a
 * finding about the code instead of a bug in the probe. So the expression is
 * evaluated outside the guard, the I/O inside it.
 */
function emit(lang: Lang, spec: ProbeRecord): string[] {
  const id = spec.id;
  const label = safeLabel(spec.label);
  const sink = sinkLiteral();
  const v = spec.kind === 'hit' ? undefined : (spec.expression || '');
  const tmp = `_cf_${id}`;

  switch (lang) {
    case 'python': {
      // Python cannot catch an exception inside a single expression, so the
      // guard costs an extra line — worth it: an unwritable sink must not
      // raise FileNotFoundError in the middle of the user's program.
      const out = v ? `"[[CF-PROBE:${id}]] ${label}=%r"%(${tmp},)` : `"[[CF-PROBE:${id}]] ${label}"`;
      const rec = v ? `"v":repr(${tmp})[:400]` : '"v":1';
      return [
        ...(v ? [`${tmp}=(${v})`] : []),
        `try: print(${out},flush=True); open("${sink}","a",encoding="utf-8")` +
          `.write(__import__("json").dumps({"id":"${id}","label":"${label}",` +
          `"t":__import__("time").time(),${rec}})+"\\n")`,
        `except Exception: pass`,
      ];
    }
    case 'js': {
      const val = v ? `const ${tmp}=(${v});` : `const ${tmp}=1;`;
      const out = v
        ? `console.log("[[CF-PROBE:${id}]] ${label}=",${tmp});`
        : `console.log("[[CF-PROBE:${id}]] ${label}");`;
      // eval() hides `require` from the TS type checker and from bundlers; in an
      // ESM or browser context it throws and the catch leaves stdout-only.
      return [`{${val}${out}try{eval("require")("fs").appendFileSync("${sink}",` +
        `JSON.stringify({id:"${id}",label:"${label}",t:Date.now(),v:${tmp}})+"\\n");}catch(_e){}}`];
    }
    case 'gdscript': {
      const val = v ? `var ${tmp} = (${v}); ` : `var ${tmp} = 1; `;
      const out = v
        ? `print("[[CF-PROBE:${id}]] ${label}=", ${tmp}); `
        : `print("[[CF-PROBE:${id}]] ${label}"); `;
      // Everything after `if f:` on this line is the guarded body, so a failed
      // open degrades to stdout-only instead of crashing the game.
      // Epoch SECONDS (like the other emitters) — engine-uptime ticks would
      // slip past toSeconds()'s epoch-ms threshold and skew timing 1000×.
      return [`${val}${out}var ${tmp}_f = FileAccess.open("${sink}", FileAccess.READ_WRITE); ` +
        `if ${tmp}_f: ${tmp}_f.seek_end(); ${tmp}_f.store_line(JSON.stringify(` +
        `{"id":"${id}","label":"${label}","t":Time.get_unix_time_from_system(),"v":str(${tmp})})); ${tmp}_f.close()`];
    }
    case 'powershell': {
      const val = v ? `$${tmp}=(${v}); ` : `$${tmp}=1; `;
      const out = `Write-Host "[[CF-PROBE:${id}]] ${label}=$${tmp}"; `;
      return [`${val}${out}try{Add-Content -LiteralPath '${sink}' -Value ` +
        `((@{id='${id}';label='${label}';t=[double](Get-Date -UFormat %s);v="$${tmp}"}` +
        `|ConvertTo-Json -Compress))}catch{}`];
    }
    case 'shell': {
      const val = v ? `${tmp}="$(${v})"; ` : `${tmp}=1; `;
      // `|| true` keeps an unwritable sink from tripping `set -e`.
      return [`${val}echo "[[CF-PROBE:${id}]] ${label}=$${tmp}"; ` +
        `{ printf '{"id":"${id}","label":"${label}","t":%s,"v":"%s"}\\n' "$(date +%s)" "$${tmp}" >> '${sink}'; } 2>/dev/null || true`];
    }
    // stdout-only languages: no dependency-free single-expression file append.
    case 'java':
      return [`System.out.println("[[CF-PROBE:${id}]] ${label}=" + (${v || '1'}));`];
    case 'csharp':
      return [`System.Console.WriteLine("[[CF-PROBE:${id}]] ${label}=" + (${v || '1'}));`];
    case 'go':
      return [`fmt.Println("[[CF-PROBE:${id}]] ${label}=", ${v || '1'})`];
    case 'rust':
      return [`println!("[[CF-PROBE:${id}]] ${label}={:?}", (${v || '1'}));`];
    case 'cpp':
      return [`std::cout << "[[CF-PROBE:${id}]] ${label}=" << (${v || '1'}) << std::endl;`];
    case 'php':
      return [`error_log("[[CF-PROBE:${id}]] ${label}=" . print_r((${v || '1'}), true));`];
    case 'ruby':
      return [`puts "[[CF-PROBE:${id}]] ${label}=#{(${v || '1'}).inspect}"`];
    case 'lua':
      return [`print("[[CF-PROBE:${id}]] ${label}=" .. tostring(${v || '1'}))`];
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export async function addProbe(args: {
  path?: string;
  anchor?: string;
  label?: string;
  expression?: string;
  kind?: string;
  code?: string;
  position?: string;
}): Promise<string> {
  const config = getConfig();
  if (!config.agentProbes) { return 'Probes are disabled (codeflare.agentProbes is off).'; }
  if (!config.agentEdit) { return 'Probes need file editing, which is disabled (codeflare.agentEdit is off).'; }
  if (registry.size >= MAX_ACTIVE_PROBES) {
    return `Too many active probes (${registry.size}). Call read_probes to collect what you have, ` +
      `then remove_probes before placing more.`;
  }

  const relPath = args.path || '';
  const anchor = (args.anchor || '').trim();
  if (!relPath || !anchor) { return 'add_probe needs both "path" and "anchor".'; }
  // Path policy applies to instrumentation too (forbidden/protected paths);
  // probes don't consume the change budget — they auto-strip at turn end.
  const verdict = previewMutation(relPath);
  if (!verdict.allowed) { return policyMessage(verdict); }
  if (anchor.includes('\n')) {
    return 'The anchor must be ONE line — the single line the probe sits next to.';
  }

  const kind = (args.kind === 'hit' || args.kind === 'custom' ? args.kind : 'value') as ProbeKind;
  if (kind === 'value' && !args.expression) {
    return 'kind "value" needs an "expression" to measure. Use kind "hit" to only count how often the line runs.';
  }
  if (args.expression && /[\r\n]/.test(args.expression)) {
    return 'The expression must be a single line — a multi-line expression breaks the probe snippet.';
  }
  if (kind === 'custom' && !args.code) {
    return 'kind "custom" needs "code": the one-line snippet to insert (print with the [[CF-PROBE:<id>]] prefix so read_probes can pick it up).';
  }

  const uri = resolveInWorkspace(relPath);
  if ('error' in uri) { return uri.error; }

  const lang = langOf(relPath);
  if (!lang && kind !== 'custom') {
    return `No built-in probe snippet for "${path.extname(relPath) || relPath}". ` +
      `Use kind "custom" and supply a one-line "code" snippet for this language yourself.`;
  }

  let original: string;
  try {
    original = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch (err: any) {
    return `Cannot read "${relPath}": ${err.message}`;
  }

  // The anchor must be unambiguous — a probe on the wrong one of five identical
  // lines measures the wrong thing and reads as a code bug.
  const lines = original.split('\n');
  const hits = lines.map((l, i) => (l.trim() === anchor ? i : -1)).filter(i => i >= 0);
  if (hits.length === 0) {
    return `Anchor line not found in ${relPath}. Read the file and copy one exact line.`;
  }
  if (hits.length > 1) {
    return `The anchor "${anchor.slice(0, 60)}" occurs ${hits.length} times in ${relPath} — ` +
      `pick a unique line (or a nearby unique one) so the probe lands where you mean it.`;
  }
  const anchorIdx = hits[0];

  await ensureSink();

  const id = `p${nextId++}`;
  const record: ProbeRecord = {
    id, relPath, kind,
    label: args.label || `${path.basename(relPath)}:${anchor.slice(0, 24)}`,
    expression: args.expression,
  };
  const bodyLines = kind === 'custom'
    ? [(args.code || '').replace(/[\r\n]+/g, ' ').trim()]
    : emit(lang!, record);
  // Every line carries the marker, so a multi-line probe (Python's try/except
  // guard) is removed as completely as a single-line one.
  const marker = `${commentToken(relPath)} codeflare:probe ${id}`;
  const before = args.position === 'before';
  // Match the anchor's own indentation. In an indentation-sensitive language a
  // probe line pasted at column 0 is a syntax error, not a measurement.
  let indent = (lines[anchorIdx].match(/^[ \t]*/) || [''])[0];
  // …unless the anchor OPENS a block ("if x:", "def f():", "func _ready():")
  // and the probe goes after it: a same-indent line where the block body must
  // start is a syntax error. Step into the block: use the body's indentation.
  if (!before && (lang === 'python' || lang === 'gdscript') &&
      /:\s*(#.*)?$/.test(lines[anchorIdx])) {
    const next = lines.slice(anchorIdx + 1).find(l => l.trim().length > 0);
    const nextIndent = next ? (next.match(/^[ \t]*/) || [''])[0] : '';
    indent = nextIndent.length > indent.length
      ? nextIndent
      : indent + (indent.includes('\t') ? '\t' : '    ');
  }
  const probeLines = bodyLines.map(l => `${indent}${l}  ${marker}`);
  lines.splice(before ? anchorIdx : anchorIdx + 1, 0, ...probeLines);

  // Record pre-state like every other mutating tool, so the turn checkpoint can
  // revert a probe insertion and the diff review sees it. (First-touch-only, so
  // this is idempotent if edit_file later touches the same file.)
  await recordPreMutation(relPath);
  try {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(lines.join('\n')));
  } catch (err: any) {
    nextId--;
    return `Failed to write "${relPath}": ${err.message}`;
  }

  registry.set(id, record);
  log(`Probe ${id} placed in ${relPath} (${kind})`);

  const sinkNote = lang && SINK_LANGS.has(lang)
    ? ''
    : ` NOTE: ${lang ?? 'this language'} probes print to stdout only — read_probes sees them only if the ` +
      `process runs via run_command or in the CodeFlare terminal.`;
  return `Probe ${id} placed ${before ? 'before' : 'after'} "${anchor.slice(0, 50)}" in ${relPath}. ` +
    `Now RUN the code, then call read_probes.${sinkNote}`;
}

export async function listProbes(): Promise<string> {
  const found: { id: string; where: string; line: string }[] = [];
  const seen = new Set<string>();

  // Deep scan: catches probes left behind by a previous window as well as the
  // ones this session placed.
  const exts = Object.keys(EXT_LANG).map(e => e.slice(1)).join(',');
  let files: vscode.Uri[] = [];
  try {
    files = await vscode.workspace.findFiles(
      `**/*.{${exts}}`,
      '**/{node_modules,.git,dist,out,build,.venv,venv,__pycache__}/**',
      2000
    );
  } catch { /* no workspace — fall through to the registry */ }

  for (const uri of files) {
    let text: string;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch { continue; }
    if (!text.includes('codeflare:probe')) { continue; }
    const rel = vscode.workspace.asRelativePath(uri);
    text.split('\n').forEach((line, i) => {
      const m = line.match(MARKER_RE);
      if (!m) { return; }
      seen.add(m[1]);
      found.push({ id: m[1], where: `${rel}:${i + 1}`, line: line.trim().slice(0, 100) });
    });
  }

  if (found.length === 0) { return 'No probes are currently placed.'; }
  const lines = found.map(f => {
    const rec = registry.get(f.id);
    const what = rec ? `${rec.kind}${rec.expression ? ` ${rec.expression}` : ''} — ${rec.label}` : '(from an earlier session)';
    return `${f.id}  ${f.where}  ${what}`;
  });
  return `${found.length} probe(s) placed:\n${lines.join('\n')}`;
}

/** Remove probe lines from one file's text. Returns the new text and a count. */
function stripText(text: string, ids?: Set<string>): { text: string; removed: string[] } {
  const removed: string[] = [];
  const kept = text.split('\n').filter(line => {
    const m = line.match(MARKER_RE);
    if (!m) { return true; }
    if (ids && !ids.has(m[1])) { return true; }
    removed.push(m[1]);
    return false;
  });
  return { text: kept.join('\n'), removed };
}

async function stripFile(relPath: string, ids?: Set<string>): Promise<string[]> {
  const uri = resolveInWorkspace(relPath);
  if ('error' in uri) { return []; }
  let text: string;
  try {
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch { return []; }
  if (!text.includes('codeflare:probe')) { return []; }
  const { text: cleaned, removed } = stripText(text, ids);
  if (removed.length === 0) { return []; }
  // Removal is a mutation too — record pre-state so it participates in the turn
  // checkpoint like the insertion did.
  await recordPreMutation(relPath);
  try {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(cleaned));
  } catch (err: any) {
    log(`Failed to strip probes from ${relPath}: ${err.message}`);
    return [];
  }
  return removed;
}

/** Workspace-relative paths of files that contain probe markers (orphan scan). */
async function scanProbeFiles(): Promise<string[]> {
  const exts = Object.keys(EXT_LANG).map(e => e.slice(1)).join(',');
  let files: vscode.Uri[] = [];
  try {
    files = await vscode.workspace.findFiles(
      `**/*.{${exts}}`,
      '**/{node_modules,.git,dist,out,build,.venv,venv,__pycache__}/**',
      2000
    );
  } catch { return []; }
  const hits: string[] = [];
  for (const uri of files) {
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      if (text.includes('codeflare:probe')) { hits.push(vscode.workspace.asRelativePath(uri)); }
    } catch { /* unreadable — skip */ }
  }
  return hits;
}

export async function removeProbes(args: { ids?: string[]; path?: string; all?: boolean }): Promise<string> {
  const ids = Array.isArray(args.ids) && args.ids.length > 0 ? new Set(args.ids) : undefined;

  // Which files to touch: the named one, or every file the registry knows about.
  let paths: string[];
  if (args.path) {
    paths = [args.path];
  } else if (ids) {
    paths = [...new Set([...ids].map(id => registry.get(id)?.relPath).filter(Boolean) as string[])];
    // Ids the registry doesn't know (a previous window placed them — list_probes
    // still shows them) live in files only a scan can find.
    if ([...ids].some(id => !registry.has(id))) {
      paths = [...new Set([...paths, ...await scanProbeFiles()])];
    }
  } else {
    paths = [...new Set([...registry.values()].map(r => r.relPath))];
    // "Remove them all" with an empty registry: strip the orphans too.
    if (paths.length === 0) { paths = await scanProbeFiles(); }
  }
  if (paths.length === 0) { return 'No probes to remove.'; }

  const removed: string[] = [];
  for (const p of paths) {
    removed.push(...await stripFile(p, ids));
  }
  removed.forEach(id => registry.delete(id));
  if (removed.length === 0) { return 'No probes matched — nothing removed.'; }
  log(`Removed ${removed.length} probe(s): ${removed.join(', ')}`);
  return `Removed ${removed.length} probe(s): ${removed.join(', ')}. The code is back to its original form.`;
}

/**
 * Remove every probe this session placed. Called at the end of a turn when
 * codeflare.probeAutoStrip is on. Returns how many lines went away.
 */
export async function stripAllProbes(): Promise<number> {
  if (registry.size === 0) { return 0; }
  const paths = [...new Set([...registry.values()].map(r => r.relPath))];
  let count = 0;
  for (const p of paths) {
    count += (await stripFile(p)).length;
  }
  registry.clear();
  return count;
}

/** True when this session has probes in the code right now. */
export function hasActiveProbes(): boolean {
  return registry.size > 0;
}

// ---------------------------------------------------------------------------
// Reading measurements back
// ---------------------------------------------------------------------------

interface Sample { id: string; label?: string; t?: number; v?: any }

/**
 * Normalize the two clocks the emitters use — epoch seconds (Python, GDScript,
 * shell, PowerShell) and epoch milliseconds (JS's Date.now()) — to seconds, so
 * inter-hit deltas are comparable within one probe. The 1e11 threshold only
 * separates epoch-s from epoch-ms; emitters must NOT use uptime clocks.
 */
function toSeconds(t: number): number {
  if (!isFinite(t)) { return 0; }
  return t > 1e11 ? t / 1000 : t;
}

function summarize(id: string, samples: Sample[]): string {
  const rec = registry.get(id);
  const head = `${id}  ${rec ? `${rec.label} [${rec.relPath}]` : '(unknown probe)'}  hits=${samples.length}`;

  const times = samples.map(s => toSeconds(Number(s.t))).filter(t => t > 0).sort((a, b) => a - b);
  let timing = '';
  if (times.length >= 2) {
    const deltas: number[] = [];
    for (let i = 1; i < times.length; i++) { deltas.push(times[i] - times[i - 1]); }
    const span = times[times.length - 1] - times[0];
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    timing = `  span=${span.toFixed(3)}s  gap avg=${avg.toFixed(4)}s ` +
      `min=${Math.min(...deltas).toFixed(4)}s max=${Math.max(...deltas).toFixed(4)}s`;
  }

  // Values: numeric stats when they parse as numbers, otherwise the distinct set.
  const raw = samples.map(s => s.v).filter(v => v !== undefined && v !== null);
  const nums = raw.map(v => Number(typeof v === 'string' ? v.replace(/^['"]|['"]$/g, '') : v))
    .filter(n => !Number.isNaN(n));
  let values = '';
  if (raw.length > 0 && nums.length === raw.length) {
    const sum = nums.reduce((a, b) => a + b, 0);
    values = `\n    numeric: min=${Math.min(...nums)} max=${Math.max(...nums)} ` +
      `avg=${(sum / nums.length).toFixed(3)} last=[${nums.slice(-6).join(', ')}]`;
  } else if (raw.length > 0) {
    const counts = new Map<string, number>();
    for (const v of raw) {
      const k = String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 80);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, n]) => `${k} ×${n}`);
    values = `\n    ${counts.size} distinct value(s): ${top.join(' | ')}` +
      `\n    last: ${raw.slice(-3).map(v => String(v).slice(0, 80)).join(' | ')}`;
  }

  return head + timing + values;
}

export async function readProbes(args: { clear?: boolean } = {}): Promise<string> {
  const samples: Sample[] = [];

  // 1. The sink file — the only source that survives a detached process.
  const uri = sinkUri();
  if (uri) {
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) { continue; }
        try {
          const obj = JSON.parse(trimmed);
          if (obj && typeof obj.id === 'string') { samples.push(obj); }
        } catch { /* half-written line from a concurrent append — skip */ }
      }
    } catch { /* no sink yet */ }
  }

  // 2. The CodeFlare terminal buffer — covers stdout-only languages and servers
  //    started in the persistent terminal. Only used for ids the sink missed,
  //    so a probe that reports through both isn't counted twice.
  const fromSink = new Set(samples.map(s => s.id));
  for (const line of getTerminalLogLines()) {
    const m = line.match(/\[\[CF-PROBE:(p\d+)\]\]\s*(.*)$/);
    if (!m || fromSink.has(m[1])) { continue; }
    const rest = m[2].trim();
    const eq = rest.indexOf('=');
    samples.push({ id: m[1], v: eq >= 0 ? rest.slice(eq + 1).trim() : 1 });
  }

  if (samples.length === 0) {
    const placed = registry.size;
    return placed === 0
      ? 'No probe data and no probes placed. Use add_probe first, then run the code.'
      : `No probe data yet — ${placed} probe(s) are placed but nothing has hit them. ` +
        `Either the code has not run since, or that path is never reached (which is itself a finding: ` +
        `the line you probed is dead for this input).`;
  }

  const byId = new Map<string, Sample[]>();
  for (const s of samples) {
    if (!byId.has(s.id)) { byId.set(s.id, []); }
    byId.get(s.id)!.push(s);
  }

  const blocks = [...byId.entries()]
    .sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)))
    .map(([id, list]) => summarize(id, list));

  // Probes that were placed but never fired are a result too — report them.
  const silent = [...registry.keys()].filter(id => !byId.has(id));
  const silentNote = silent.length > 0
    ? `\n\nNever hit (that code path did not run): ${silent.join(', ')}`
    : '';

  if (args.clear) {
    const s = sinkUri();
    if (s) {
      try { await vscode.workspace.fs.writeFile(s, new TextEncoder().encode('')); } catch { /* ignore */ }
    }
  }

  return `Probe measurements (${samples.length} sample(s) across ${byId.size} probe(s))` +
    `${args.clear ? ', sink cleared' : ''}:\n${blocks.join('\n')}${silentNote}`;
}
