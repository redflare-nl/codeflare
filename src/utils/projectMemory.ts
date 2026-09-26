import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { log } from './logger';

/**
 * Durable project memory, stored under ExtensionContext.storageUri — separate from chat
 * history, so proven facts about a project (how it's built/tested, its
 * engine/framework, key architecture, project rules) survive across
 * conversations. The model READS it (injected into the prompt each turn) and
 * WRITES to it deliberately via the remember/forget tools. This is for
 * high-confidence, lasting facts only — never transient state or guesses.
 */

const HEADER =
  '# CodeFlare project memory\n' +
  '<!-- Durable, proven facts about this project, maintained by CodeFlare\'s remember/forget ' +
  'tools. You may edit by hand. One fact per "- [category] …" line. -->\n\n';

const MAX_FACTS = 80;
const MAX_INJECT_CHARS = 4000;
const MIGRATED = '<!-- CodeFlare legacy project-memory import completed: v1 -->';
const UNAVAILABLE = 'Project memory unavailable: this workspace has no VS Code storage location.';
interface MemoryLocation { storage: vscode.Uri; legacy?: vscode.Uri }
let location: MemoryLocation | undefined;
let writes: Promise<unknown> = Promise.resolve();

/** Configure once at activation. Never derive a writable location from the project. */
export function configureProjectMemory(storageUri: vscode.Uri | undefined, legacyRoot: vscode.Uri | undefined): void {
  location = storageUri ? { storage: storageUri, legacy: legacyRoot } : undefined;
}

function missing(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === 'FileNotFound' || code === 'ENOENT';
}

async function readRaw(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(await vscode.workspace.fs.readFile(uri));
  } catch (error) {
    if (missing(error)) { return undefined; }
    throw error;
  }
}

/** The fact lines only ("- [cat] …"), in file order. */
function factLines(raw: string | undefined): string[] {
  if (raw === undefined) { return []; }
  // A damaged or unrelated file must not silently become an empty memory store.
  // Remove standalone metadata comments, never comment syntax inside a fact.
  const content = raw.replace(/(^|\n)[ \t]*<!--[\s\S]*?-->[ \t]*(?=\r?\n|$)/g, '$1');
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (raw.includes('\0') || lines.some(l => l !== '# CodeFlare project memory' && !/^-\s+\S/.test(l))) {
    throw new Error('Project memory contains unrecognized content; the existing file was preserved.');
  }
  return lines.filter(l => /^-\s+\S/.test(l));
}

async function writeFacts(target: MemoryLocation, facts: string[]): Promise<void> {
  const directory = vscode.Uri.joinPath(target.storage, 'memory');
  const uri = vscode.Uri.joinPath(directory, 'memory.md');
  const temporary = vscode.Uri.joinPath(directory, `memory.${randomUUID()}.tmp`);
  const body = HEADER + MIGRATED + '\n\n' + facts.join('\n') + (facts.length ? '\n' : '');
  try {
    await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(body));
    await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
  } finally {
    try { await vscode.workspace.fs.delete(temporary); } catch { /* Rename consumes the temporary file. */ }
  }
}

/** Serialize complete read/migrate/modify transactions, including callers from other windows. */
async function transaction<T>(target: MemoryLocation, work: (facts: string[]) => Promise<T>): Promise<T> {
  const operation = writes.then(async () => {
    const directory = vscode.Uri.joinPath(target.storage, 'memory');
    await vscode.workspace.fs.createDirectory(directory);
    // Remote URI providers still use their own read/write/atomic-rename implementation.
    // Local extension-host storage additionally supports an exclusive cross-window lock.
    const lockPath = target.storage.scheme === 'file' ? path.join(directory.fsPath, 'memory.lock') : undefined;
    let lock: fs.FileHandle | undefined;
    if (lockPath) {
      for (let attempt = 0; ; attempt++) {
        try { lock = await fs.open(lockPath, 'wx'); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
          if (attempt >= 40) {
            throw new Error(`Project memory is locked by another writer. After an editor crash, remove ${lockPath} only when no writer is active.`);
          }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
    }
    try {
      const raw = await readRaw(vscode.Uri.joinPath(directory, 'memory.md'));
      const facts = factLines(raw);
      if (!raw?.includes(MIGRATED)) {
        const legacy = target.legacy ? await readRaw(vscode.Uri.joinPath(target.legacy, '.codeflare', 'memory.md')) : undefined;
        const seen = new Set(facts.map(factKey));
        for (const fact of factLines(legacy)) {
          const key = factKey(fact);
          if (!seen.has(key)) { facts.push(fact); seen.add(key); }
        }
        // Persist the marker and imported facts together. An empty memory after forget
        // is still marked, so reactivation cannot resurrect the preserved legacy file.
        await writeFacts(target, facts);
      }
      return await work(facts);
    } finally {
      if (lock) { await lock.close(); await fs.unlink(lockPath!); }
    }
  });
  writes = operation.then(() => undefined, () => undefined);
  return operation;
}

/** Project-memory facts as a prompt block (bounded), or '' when there are none. */
export async function loadProjectMemory(): Promise<string> {
  const target = location;
  if (!target) { return ''; }
  return transaction(target, async facts => {
    let out = '';
    for (const f of facts) {
      if (out.length + f.length + 1 > MAX_INJECT_CHARS) { break; }
      out += f + '\n';
    }
    return out.trim();
  });
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const factKey = (s: string) => norm(s.replace(/^-\s+(\[[^\]]*\]\s*)?/, ''));

// Code-structure trivia the model can re-derive by reading the code — it must
// NOT clutter durable project memory. Durable facts describe how the project
// works (engine/framework, how tests run, architecture rules), not where a
// symbol lives. Rejecting these keeps the memory a signal, not a junk drawer.
const TRIVIA_RE: RegExp[] = [
  // "file/module X contains/defines/has function/class/… Y"
  /\b(file|module|script|class)\b.*\b(contains?|defines?|declares?|has|holds?|includes?|exports?)\b.*\b(function|method|class|const|let|var|variable|interface|type|enum|def|struct|field|property|component|hook)\b/i,
  // "function/class/method Foo is defined in / lives in / located at …"
  /\b(function|method|class|def|interface|struct|component|const|variable)\s+[\w$]+\b.*\b(is (defined|declared|located|found|implemented)|lives|resides|can be found)\b/i,
  // "contains/defines a function/class/…"
  /\b(contains?|defines?|declares?|implements?)\s+(a |an |the )?(function|method|class|variable|const|interface|type|enum|def|struct|component)\b/i,
  // pinpoints a line — inherently volatile
  /\bline\s+\d+\b/i,
];
function looksTrivial(text: string): boolean {
  return TRIVIA_RE.some(re => re.test(text));
}

/** Record a durable, proven fact. Deduplicates and caps total size. */
export async function rememberFact(fact: string, category?: string): Promise<string> {
  const text = (fact || '').replace(/\s+/g, ' ').trim();
  if (!text) { return 'Nothing to remember (empty fact).'; }
  const target = location;
  if (!target) { return UNAVAILABLE; }
  // Refuse per-symbol code structure — it's re-derivable and pollutes memory.
  if (looksTrivial(text)) {
    return `Not remembered — that reads as code-structure detail you can re-derive by reading the code ` +
      `(what file/symbol contains what). Project memory is for durable facts about how the project works: ` +
      `the engine/framework, how to build and run tests, architecture decisions, project-specific rules.`;
  }

  try {
    return await transaction(target, async facts => {
      const nf = norm(text);
      // Only treat substring overlap as "the same fact" when the shorter side is
      // reasonably long — otherwise a short stored fact ("[stack] go") wrongly
      // matches an unrelated new one ("mongo driver required").
      const MIN_SUBSTR = 12;
      const cat = (category || '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const line = cat ? `- [${cat}] ${text}` : `- ${text}`;
      for (let i = 0; i < facts.length; i++) {
        const body = factKey(facts[i]);
        if (body === nf) {
          return `Already known (a matching fact is stored): "${facts[i]}". Not duplicated.`;
        }
        if (nf.length >= MIN_SUBSTR && body.includes(nf)) {
          return `Already known (a more detailed fact is stored): "${facts[i]}". Not duplicated.`;
        }
        // A more informative version refines the original instead of duplicating it.
        if (body.length >= MIN_SUBSTR && nf.includes(body)) {
          const old = facts[i];
          facts[i] = line;
          await writeFacts(target, facts);
          log(`Project memory: refined "${old}" → "${line}"`);
          return `Refined a stored fact: ${line}`;
        }
      }
      if (facts.length >= MAX_FACTS) {
        return `Project memory is full (${MAX_FACTS} facts). Use forget to remove a stale one first — ` +
          `keep only durable, proven facts.`;
      }

      facts.push(line);
      await writeFacts(target, facts);
      log(`Project memory: remembered "${line}"`);
      return `Remembered: ${line}`;
    });
  } catch (error) {
    return `Failed to save fact: ${(error as Error).message}`;
  }
}

/**
 * Remove every stored fact. Goes through the same locked transaction as the
 * remember/forget tools, so it cannot race another window, and writes the file
 * back empty rather than deleting it — the MIGRATED marker must survive, or the
 * next read would re-import the legacy `.codeflare/memory.md` and resurrect
 * everything the user just cleared. Returns how many facts were removed.
 */
export async function clearProjectMemory(): Promise<number> {
  const target = location;
  if (!target) { throw new Error(UNAVAILABLE); }
  return transaction(target, async facts => {
    if (facts.length === 0) { return 0; }
    await writeFacts(target, []);
    log(`Project memory: cleared ${facts.length} fact(s)`);
    return facts.length;
  });
}

/** Remove any stored fact matching `match` (case-insensitive substring). */
export async function forgetFact(match: string): Promise<string> {
  const needle = norm(match || '');
  if (!needle) { return 'Nothing to forget (empty match).'; }
  const target = location;
  if (!target) { return UNAVAILABLE; }

  try {
    return await transaction(target, async facts => {
      const kept = facts.filter(f => !norm(f).includes(needle));
      const removed = facts.length - kept.length;
      if (removed === 0) { return `No stored fact matched "${match}".`; }
      await writeFacts(target, kept);
      log(`Project memory: forgot ${removed} fact(s) matching "${match}"`);
      return `Forgot ${removed} fact(s) matching "${match}".`;
    });
  } catch (error) {
    return `Failed to update memory: ${(error as Error).message}`;
  }
}
