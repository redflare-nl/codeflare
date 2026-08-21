import * as vscode from 'vscode';
import { log } from '../utils/logger';

/**
 * A compact map of the workspace — every source file with its top-level
 * definitions — injected into the model's context so it can reuse what already
 * exists and match the codebase's conventions instead of reinventing them.
 * Built with cheap per-language regexes (no language server round-trips, so it
 * stays fast over hundreds of files) and cached; the cache is invalidated when
 * the agent writes a file and rebuilt lazily on the next turn.
 */

// Same noise/huge dirs the file tools skip.
const IGNORED = [
  'node_modules', '.git', 'dist', 'out', 'build', '.vscode-test',
  '.next', '.cache', 'coverage', '__pycache__', '.venv', 'venv',
  '.codeflare-trash', '.codeflare',
];
const EXCLUDE = `{${IGNORED.map(d => `**/${d}/**`).join(',')}}`;

const MAX_FILES = 500;        // files scanned for the map
const MAX_FILE_BYTES = 200_000; // skip very large files
const MAX_SYMBOLS_PER_FILE = 10;
const MAX_MAP_CHARS = 5000;   // budget for the injected map text

// Source extensions worth mapping (skip data/asset/lockfiles).
const SOURCE_EXTS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'c', 'h',
  'cpp', 'hpp', 'cc', 'hh', 'cs', 'rb', 'php', 'swift', 'kt', 'kts', 'scala',
  'vue', 'svelte', 'lua', 'gd', 'sh', 'ps1', 'ex', 'exs', 'dart',
];
const SOURCE_EXT = new RegExp(`\\.(${SOURCE_EXTS.join('|')})$`, 'i');
// Restrict findFiles to source files so the MAX_FILES cap counts SOURCE files,
// not assets — otherwise an asset-heavy repo (a Godot project with thousands of
// .png/.import/.tres) can exhaust the cap with non-source files and return few
// or zero scripts, gutting the map. SOURCE_EXT is kept as a case-insensitive
// backstop since glob matching can be case-sensitive.
const INCLUDE = `**/*.{${SOURCE_EXTS.join(',')}}`;

/**
 * Top-level declaration matchers. Applied per line; the FIRST capturing group
 * is the symbol name. Deliberately broad and language-family based rather than
 * exhaustive — a name that shows up is worth listing even if the language guess
 * is loose.
 */
const DECL_RE: RegExp[] = [
  // JS/TS/…: export/async function, class, const/let, interface, type, enum
  /^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|static\s+|abstract\s+)*(?:async\s+)?(?:function\*?|class|interface|enum|type|const|let|var)\s+([A-Za-z_$][\w$]*)/,
  // Python / Ruby: def / class
  /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/,
  // Go: func (recv) Name / type Name
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/,
  // Rust / others: fn / struct / trait / impl / mod / enum
  /^\s*(?:pub\s+(?:\([^)]*\)\s*)?)?(?:unsafe\s+)?(?:async\s+)?(?:fn|struct|trait|impl|mod|enum)\s+([A-Za-z_]\w*)/,
  // C/C++/C#/Java-ish: type Name( — a function/method signature at low indent
  /^[A-Za-z_][\w:<>,*&\s]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/,
];

/** Extract up to MAX_SYMBOLS_PER_FILE top-level-ish symbol names from source. */
function extractSymbols(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.length > 400) { continue; }
    // Only consider low-indent lines — top-level or one level in — so we list
    // the file's shape, not every local variable.
    const indent = line.length - line.trimStart().length;
    if (indent > 4) { continue; }
    for (const re of DECL_RE) {
      const m = re.exec(line);
      if (m && m[1] && !seen.has(m[1]) && !/^(if|for|while|switch|catch|return|else|do)$/.test(m[1])) {
        seen.add(m[1]);
        names.push(m[1]);
        break;
      }
    }
    if (names.length >= MAX_SYMBOLS_PER_FILE) { break; }
  }
  return names;
}

interface FileEntry { rel: string; symbols: string[] }

let cache: { entries: FileEntry[]; text: string } | undefined;
let dirty = true;
let building: Promise<void> | undefined;
// Bumped on every invalidation. build() captures it at entry and only clears
// `dirty` if it hasn't changed — so a write that lands DURING a build isn't
// swallowed by the build's completion setting dirty=false.
let buildGen = 0;

/** Mark the map stale (call after the agent writes/moves/creates a file). */
export function invalidateRepoMap(): void {
  dirty = true;
  buildGen++;
}

function relOf(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri).replace(/\\/g, '/');
}

async function build(): Promise<void> {
  const started = Date.now();
  const gen = buildGen;
  const files = await vscode.workspace.findFiles(INCLUDE, EXCLUDE, MAX_FILES);
  const entries: FileEntry[] = [];

  for (const uri of files) {
    const rel = relOf(uri);
    if (!SOURCE_EXT.test(rel)) { continue; }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File || stat.size > MAX_FILE_BYTES) { continue; }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.includes(0)) { continue; } // binary
      const symbols = extractSymbols(new TextDecoder().decode(bytes));
      entries.push({ rel, symbols });
    } catch { /* unreadable — skip */ }
  }

  entries.sort((a, b) => a.rel.localeCompare(b.rel));

  // Render within the char budget; note how many files were dropped.
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const e of entries) {
    const syms = e.symbols.length ? `: ${e.symbols.join(', ')}` : '';
    const line = `${e.rel}${syms}`;
    if (used + line.length + 1 > MAX_MAP_CHARS) { break; }
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  const omitted = entries.length - shown;
  const text = lines.join('\n') + (omitted > 0 ? `\n… (${omitted} more source file(s) not shown)` : '');

  cache = { entries, text };
  // Only mark clean if no invalidation arrived while we were scanning; otherwise
  // leave dirty=true so ensureBuilt rebuilds and picks up the change.
  if (buildGen === gen) { dirty = false; }
  log(`Repo map built: ${entries.length} source file(s), ${shown} shown (${Date.now() - started}ms)`);
}

async function ensureBuilt(): Promise<void> {
  // Loop so an invalidation that lands DURING a build triggers one more rebuild
  // (build() leaves dirty=true in that case) instead of serving a stale map.
  while (!cache || dirty) {
    if (!building) {
      building = build().finally(() => { building = undefined; });
    }
    await building;
  }
}

/**
 * The project map as prompt text, or '' when there's nothing to map. Cached;
 * rebuilds only when marked dirty. Never throws — a failure yields ''.
 */
export async function getRepoMap(): Promise<string> {
  if (!vscode.workspace.workspaceFolders?.length) { return ''; }
  try {
    await ensureBuilt();
    return cache?.text || '';
  } catch (err: any) {
    log(`Repo map build failed: ${err.message}`);
    return '';
  }
}

// ── Relevance ranking (find_related tool) ────────────────────────────

const MAX_RELATED_FILES = 6;
const EXCERPT_CONTEXT = 3;

function tokenize(query: string): string[] {
  return [...new Set(
    query.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length > 2)
  )];
}

/**
 * Rank workspace source files by how relevant they are to `query`, scoring
 * filename, symbol names, and content matches, and return the top files with
 * their definitions and the best-matching snippet. Gives the model ranked
 * retrieval ("show me how this codebase already does X") that the flat,
 * unranked search_text does not.
 */
export async function findRelated(query: string): Promise<string> {
  if (!query.trim()) { return 'Empty query.'; }
  if (!vscode.workspace.workspaceFolders?.length) { return 'No workspace folder is open.'; }
  const terms = tokenize(query);
  if (terms.length === 0) { return 'Query has no searchable terms (use words of 3+ characters).'; }

  await ensureBuilt();
  const symByFile = new Map<string, string[]>();
  for (const e of cache?.entries || []) { symByFile.set(e.rel, e.symbols); }

  const files = await vscode.workspace.findFiles(INCLUDE, EXCLUDE, MAX_FILES);
  type Scored = { rel: string; score: number; symbols: string[]; bestLine: number; text: string };
  const scored: Scored[] = [];

  for (const uri of files) {
    const rel = relOf(uri);
    if (!SOURCE_EXT.test(rel)) { continue; }
    let text: string;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File || stat.size > MAX_FILE_BYTES) { continue; }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.includes(0)) { continue; }
      text = new TextDecoder().decode(bytes);
    } catch { continue; }

    const lower = text.toLowerCase();
    const relLower = rel.toLowerCase();
    const symbols = symByFile.get(rel) ?? extractSymbols(text);
    const symLower = symbols.map(s => s.toLowerCase());

    let score = 0;
    for (const t of terms) {
      if (relLower.includes(t)) { score += 6; }
      if (symLower.some(s => s.includes(t))) { score += 4; }
      // Count content occurrences, capped so one huge file can't dominate.
      let idx = lower.indexOf(t), n = 0;
      while (idx >= 0 && n < 8) { n++; idx = lower.indexOf(t, idx + t.length); }
      score += n;
    }
    if (score === 0) { continue; }

    // Best line = first line matching the most query terms.
    const lines = text.split('\n');
    let bestLine = 0, bestHits = 0;
    for (let i = 0; i < lines.length; i++) {
      const ll = lines[i].toLowerCase();
      let hits = 0;
      for (const t of terms) { if (ll.includes(t)) { hits++; } }
      if (hits > bestHits) { bestHits = hits; bestLine = i; if (hits === terms.length) { break; } }
    }
    scored.push({ rel, score, symbols, bestLine, text });
  }

  if (scored.length === 0) { return `No files look related to "${query}".`; }
  scored.sort((a, b) => b.score - a.score);

  const out: string[] = [`Files related to "${query}" (most relevant first):`];
  for (const s of scored.slice(0, MAX_RELATED_FILES)) {
    const defs = s.symbols.length ? `\n  defs: ${s.symbols.join(', ')}` : '';
    const lines = s.text.split('\n');
    const from = Math.max(0, s.bestLine - EXCERPT_CONTEXT);
    const to = Math.min(lines.length - 1, s.bestLine + EXCERPT_CONTEXT);
    const excerpt = lines.slice(from, to + 1)
      .map((l, i) => `  ${String(from + i + 1).padStart(4)} | ${l.slice(0, 160)}`)
      .join('\n');
    out.push(`\n${s.rel}${defs}\n${excerpt}`);
  }
  out.push(`\nRead a file in full before editing it, and match the patterns you see here.`);
  return out.join('\n');
}
