import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { log } from './logger';

/**
 * Executable discovery. Interpreters and build tools (python, java, php, godot, …)
 * aren't always on PATH — they can be a versioned local binary sitting in the
 * project or a parent folder. Instead of hardcoding each one, the agent locates
 * it: PATH first, then the workspace root, then up the parent chain. A found
 * executable is TRUSTED for the session (so running it needs no prompt) and
 * REMEMBERED in project memory, so the next session doesn't have to search again.
 */

const isWin = process.platform === 'win32';
const EXE_EXTS = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];

function workspaceRootPath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function isFile(p: string): Promise<boolean> {
  try { return (await fs.promises.stat(p)).isFile(); } catch { return false; }
}

/** Find `name` (exact, or a "name*" versioned binary) as an executable in one dir. */
async function matchInDir(dir: string, nameLc: string): Promise<string | undefined> {
  // Exact candidates first — a cheap stat, no directory listing.
  for (const ext of EXE_EXTS) {
    const cand = path.join(dir, nameLc + ext);
    if (await isFile(cand)) { return cand; }
  }
  // Versioned/local binary (e.g. godot → Godot_v4.7.1-stable_win64.exe): list + prefix match.
  let entries: string[];
  try { entries = await fs.promises.readdir(dir); } catch { return undefined; }
  for (const e of entries) {
    const lc = e.toLowerCase();
    if (!lc.startsWith(nameLc)) { continue; }
    if (isWin ? !/\.(exe|cmd|bat)$/.test(lc) : !!path.extname(lc)) { continue; }
    // Only accept a VERSIONED variant of the exact name: the text after the
    // prefix must be empty or a version-like token (an optional separator, an
    // optional "v", then a digit). Without this, an unbounded prefix match
    // would pick — and auto-trust — an unrelated binary like "godot-payload.exe"
    // for "godot" or "cmake-gui.exe" for "cmake", a trust-boundary escape since
    // repo contents can be attacker-influenced.
    const stem = isWin ? lc.replace(/\.(exe|cmd|bat)$/, '') : lc;
    const rest = stem.slice(nameLc.length);
    if (!(rest === '' || /^[-_. ]?v?\d/.test(rest))) { continue; }
    const full = path.join(dir, e);
    if (await isFile(full)) { return full; }
  }
  return undefined;
}

export interface FoundExe { path: string; source: string; }

/**
 * Resolve a user-configured INSTALL ROOT to the executable inside it. Accepts
 * the three shapes a user realistically types for e.g. Blender:
 *   - the executable itself   …/Blender 5.1/blender.exe
 *   - the install folder      …/Blender 5.1
 *   - its parent              …/Blender Foundation      (one versioned level down)
 * The parent form matters because that is the folder users recognise — the
 * version number is exactly what they don't want to re-type after an upgrade.
 * Returns undefined when nothing matches; callers fall back to PATH discovery.
 */
export async function resolveExecutableRoot(root: string, name: string): Promise<string | undefined> {
  const raw = (root || '').trim().replace(/^"|"$/g, '');
  if (!raw) { return undefined; }
  const nameLc = name.trim().toLowerCase();

  // 1. A direct path to the binary.
  if (await isFile(raw)) { return raw; }

  // 2. The install folder: <root>/<name>(.exe)
  const direct = await matchInDir(raw, nameLc);
  if (direct) { return direct; }

  // 3. The parent of a versioned install folder: <root>/*/<name>(.exe). Sorted
  //    descending so the NEWEST version wins when several are installed
  //    ("Blender 5.1" over "Blender 4.2") — a lexical sort is right for the
  //    zero-padded-free "Blender <major>.<minor>" convention up to 2 digits.
  let entries: string[];
  try { entries = await fs.promises.readdir(raw); } catch { return undefined; }
  for (const e of entries.sort().reverse()) {
    const hit = await matchInDir(path.join(raw, e), nameLc);
    if (hit) { return hit; }
  }
  return undefined;
}

/**
 * Locate an executable by name. Search order: PATH → workspace root → up to 3
 * parent levels. PATH is checked by exact name only (versioned binaries live
 * locally, not on PATH); the workspace/parent dirs also match "name*".
 */
export async function findExecutable(name: string): Promise<FoundExe | null> {
  const nameLc = name.trim().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (!nameLc) { return null; }

  for (const dir of (process.env.PATH || '').split(isWin ? ';' : ':')) {
    if (!dir) { continue; }
    for (const ext of EXE_EXTS) {
      const cand = path.join(dir, nameLc + ext);
      if (await isFile(cand)) { return { path: cand, source: 'PATH' }; }
    }
  }

  let dir = workspaceRootPath();
  for (let i = 0; i < 4 && dir; i++) {
    const hit = await matchInDir(dir, nameLc);
    if (hit) { return { path: hit, source: i === 0 ? 'workspace root' : `${i} level(s) up` }; }
    const parent = path.dirname(dir);
    if (parent === dir) { break; }
    dir = parent;
  }
  return null;
}

// ── Session trust ────────────────────────────────────────────────
// Basenames of discovered executables (lowercased), trusted for this session so
// running them skips the confirmation prompt. Populated by discovery and by
// loading remembered "[exe] name = path" facts at the start of each turn.
const trustedExes = new Set<string>();
// Logical tool name (lowercased, e.g. "godot") → discovered full path, so other
// modules (stack detection) can build commands that work when the tool is NOT
// on PATH under its bare name.
const discovered = new Map<string, string>();

/** Register a discovered executable. Returns true if it was NEW this session. */
export function registerExecutable(fullPath: string, name?: string): boolean {
  const base = path.basename(fullPath).toLowerCase();
  let changed = false;
  if (base && !trustedExes.has(base)) { trustedExes.add(base); changed = true; }
  const key = (name || base.replace(/\.(exe|cmd|bat)$/, '')).trim().toLowerCase();
  if (key && discovered.get(key) !== fullPath) { discovered.set(key, fullPath); changed = true; }
  return changed;
}

export function trustedExecutables(): string[] {
  return [...trustedExes];
}

/** The discovered full path of a tool ("godot" → "C:\…\Godot_v4.7.1….exe"), if known. */
export function discoveredPath(name: string): string | undefined {
  return discovered.get(name.trim().toLowerCase());
}

/**
 * Register every "[exe] name = path" fact from the project memory text.
 * Returns true when anything NEW was registered (callers then invalidate
 * caches that bake in executable paths, e.g. stack detection).
 */
export function loadExecutablesFromMemory(memoryText: string): boolean {
  let changed = false;
  for (const m of (memoryText || '').matchAll(/\[exe\]\s*([^=\n]*?)\s*=\s*(.+)$/gim)) {
    const p = m[2].trim();
    if (p && registerExecutable(p, m[1].trim() || undefined)) {
      changed = true;
      log(`Trusting remembered executable: ${p}`);
    }
  }
  return changed;
}
