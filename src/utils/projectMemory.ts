import * as vscode from 'vscode';
import { log } from './logger';

/**
 * Durable project memory, stored in .codeflare/memory.md — separate from chat
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

function memoryUri(): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) { return undefined; }
  return vscode.Uri.joinPath(root, '.codeflare', 'memory.md');
}

async function readRaw(): Promise<string> {
  const uri = memoryUri();
  if (!uri) { return ''; }
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch { return ''; }
}

/** The fact lines only ("- [cat] …"), in file order. */
function factLines(raw: string): string[] {
  return raw.split('\n').map(l => l.trimEnd()).filter(l => /^-\s+\S/.test(l));
}

async function writeFacts(facts: string[]): Promise<void> {
  const uri = memoryUri();
  if (!uri) { return; }
  const body = HEADER + facts.join('\n') + (facts.length ? '\n' : '');
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(body));
}

/** Project-memory facts as a prompt block (bounded), or '' when there are none. */
export async function loadProjectMemory(): Promise<string> {
  const facts = factLines(await readRaw());
  if (facts.length === 0) { return ''; }
  let out = '';
  for (const f of facts) {
    if (out.length + f.length + 1 > MAX_INJECT_CHARS) { break; }
    out += f + '\n';
  }
  return out.trim();
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

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
  if (!memoryUri()) { return 'No workspace folder is open.'; }
  // Refuse per-symbol code structure — it's re-derivable and pollutes memory.
  if (looksTrivial(text)) {
    return `Not remembered — that reads as code-structure detail you can re-derive by reading the code ` +
      `(what file/symbol contains what). Project memory is for durable facts about how the project works: ` +
      `the engine/framework, how to build and run tests, architecture decisions, project-specific rules.`;
  }

  const facts = factLines(await readRaw());
  const nf = norm(text);
  // Only treat substring overlap as "the same fact" when the shorter side is
  // reasonably long — otherwise a short stored fact ("[stack] go") wrongly
  // matches an unrelated new one ("mongo driver required"), and a refined fact
  // ("… build:prod") is rejected as a duplicate of the shorter original.
  const MIN_SUBSTR = 12;
  const cat = (category || '').replace(/[[\]]/g, '').trim().toLowerCase();
  const line = cat ? `- [${cat}] ${text}` : `- ${text}`;
  for (let i = 0; i < facts.length; i++) {
    const body = norm(facts[i].replace(/^-\s+(\[[^\]]*\]\s*)?/, ''));
    if (body === nf) {
      return `Already known (a matching fact is stored): "${facts[i]}". Not duplicated.`;
    }
    // The new fact is fully contained in an existing, more detailed one.
    if (nf.length >= MIN_SUBSTR && body.includes(nf)) {
      return `Already known (a more detailed fact is stored): "${facts[i]}". Not duplicated.`;
    }
    // The new fact is a superset of a stored shorter one → refine it in place
    // instead of rejecting the more informative version.
    if (body.length >= MIN_SUBSTR && nf.includes(body)) {
      const old = facts[i];
      facts[i] = line;
      try {
        await writeFacts(facts);
      } catch (err: any) {
        return `Failed to save fact: ${err.message}`;
      }
      log(`Project memory: refined "${old}" → "${line}"`);
      return `Refined a stored fact: ${line}`;
    }
  }
  if (facts.length >= MAX_FACTS) {
    return `Project memory is full (${MAX_FACTS} facts). Use forget to remove a stale one first — ` +
      `keep only durable, proven facts.`;
  }

  facts.push(line);
  try {
    await writeFacts(facts);
  } catch (err: any) {
    return `Failed to save fact: ${err.message}`;
  }
  log(`Project memory: remembered "${line}"`);
  return `Remembered: ${line}`;
}

/** Remove any stored fact matching `match` (case-insensitive substring). */
export async function forgetFact(match: string): Promise<string> {
  const needle = norm(match || '');
  if (!needle) { return 'Nothing to forget (empty match).'; }
  if (!memoryUri()) { return 'No workspace folder is open.'; }

  const facts = factLines(await readRaw());
  const kept = facts.filter(f => !norm(f).includes(needle));
  const removed = facts.length - kept.length;
  if (removed === 0) { return `No stored fact matched "${match}".`; }
  try {
    await writeFacts(kept);
  } catch (err: any) {
    return `Failed to update memory: ${err.message}`;
  }
  log(`Project memory: forgot ${removed} fact(s) matching "${match}"`);
  return `Forgot ${removed} fact(s) matching "${match}".`;
}
