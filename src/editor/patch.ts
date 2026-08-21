/**
 * Unified-diff parsing and lenient application. A more reliable edit path than
 * exact search/replace: hunks carry context lines, so a hunk can be located by
 * matching its context even when the model's line numbers are off, and applied
 * with whitespace fuzz. Pure functions (no vscode/fs) so they're testable; the
 * tool layer handles reading/writing files and the checkpoint.
 */

export type DiffLineType = ' ' | '-' | '+';

export interface Hunk {
  oldStart: number;                       // 1-based line from the @@ header (a hint, not trusted)
  lines: { type: DiffLineType; text: string }[];
}

export interface FilePatch {
  oldPath: string;                        // 'a/…' stripped; '/dev/null' for a new file
  newPath: string;                        // 'b/…' stripped; '/dev/null' for a deletion
  hunks: Hunk[];
  isNew: boolean;
  isDelete: boolean;
}

function stripPrefix(p: string): string {
  const t = p.trim().replace(/\t.*$/, '');       // drop trailing "\t<timestamp>"
  if (t === '/dev/null') { return t; }
  return t.replace(/^[ab]\//, '');
}

/** Parse a (possibly multi-file) unified diff. Ignores git extended headers. */
export function parseUnifiedDiff(patch: string): FilePatch[] {
  const lines = patch.split('\n');
  // A patch string almost always ends in a newline, so split() leaves a trailing
  // '' element. Left in, the bare-empty-line branch below would append a phantom
  // empty context line to the final hunk, making a valid patch fail to apply (or
  // match at the wrong place). Drop that one artifact; real empty content lines
  // are still encoded with a ' '/'+'/'-' prefix and unaffected.
  if (lines.length && lines[lines.length - 1] === '') { lines.pop(); }
  const files: FilePatch[] = [];
  let cur: FilePatch | undefined;
  let hunk: Hunk | undefined;

  const closeHunk = () => { if (cur && hunk) { cur.hunks.push(hunk); hunk = undefined; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Inside an open hunk, `--- x` is ambiguous: a genuine file header is always
    // followed by `+++ `, whereas a deleted line whose CONTENT starts with `-- `
    // (Lua/SQL/Haskell comments) is diff-encoded as `--- ...`. Only treat it as a
    // header when no hunk is open (lenient, as before) or the next line is `+++ `;
    // otherwise fall through and let it be parsed as a deletion line.
    if (line.startsWith('--- ') && (!hunk || (lines[i + 1] ?? '').startsWith('+++ '))) {
      closeHunk();
      const oldPath = stripPrefix(line.slice(4));
      // The very next line should be '+++ '.
      const nextRaw = lines[i + 1] ?? '';
      const newPath = nextRaw.startsWith('+++ ') ? stripPrefix(nextRaw.slice(4)) : oldPath;
      if (nextRaw.startsWith('+++ ')) { i++; }
      cur = {
        oldPath, newPath, hunks: [],
        isNew: oldPath === '/dev/null',
        isDelete: newPath === '/dev/null',
      };
      files.push(cur);
      continue;
    }
    if (!cur) { continue; }                        // skip git headers before the first ---
    if (line.startsWith('@@')) {
      closeHunk();
      const m = /^@@\s*-(\d+)(?:,\d+)?\s+\+\d+(?:,\d+)?\s*@@/.exec(line);
      hunk = { oldStart: m ? parseInt(m[1], 10) : 1, lines: [] };
      continue;
    }
    if (!hunk) { continue; }
    if (line.startsWith('\\')) { continue; }       // "\ No newline at end of file"
    const c = line[0];
    if (c === '+' || c === '-' || c === ' ') {
      hunk.lines.push({ type: c, text: line.slice(1) });
    } else if (line === '') {
      hunk.lines.push({ type: ' ', text: '' });    // bare empty line = empty context line
    } else {
      // Any other line ends the current hunk (e.g. a following 'diff --git').
      closeHunk();
    }
  }
  closeHunk();
  return files.filter(f => f.hunks.length > 0 || f.isNew || f.isDelete);
}

const rtrim = (s: string) => s.replace(/\s+$/, '');

/** Find `block` (array of lines) in `lines` at/after `from`, whitespace-tolerant. */
function findBlock(lines: string[], block: string[], hint: number, from: number): number {
  if (block.length === 0) { return Math.max(0, Math.min(hint, lines.length)); }
  const matchAt = (idx: number): boolean => {
    if (idx < 0 || idx + block.length > lines.length) { return false; }
    for (let k = 0; k < block.length; k++) {
      if (rtrim(lines[idx + k]) !== rtrim(block[k])) { return false; }
    }
    return true;
  };
  // Prefer the position the header hints at, then scan forward from `from`,
  // then scan the whole file (models often misplace line numbers).
  if (matchAt(hint)) { return hint; }
  for (let i = Math.max(0, from); i + block.length <= lines.length; i++) {
    if (matchAt(i)) { return i; }
  }
  for (let i = 0; i + block.length <= lines.length; i++) {
    if (matchAt(i)) { return i; }
  }
  return -1;
}

export interface ApplyResult { ok: boolean; content: string; error?: string; applied: number }

/** Apply a file's hunks to its current text. Returns the new content or an error. */
export function applyFilePatch(original: string, fp: FilePatch): ApplyResult {
  // New file: the added lines are the whole content.
  if (fp.isNew) {
    const added = fp.hunks.flatMap(h => h.lines.filter(l => l.type !== '-').map(l => l.text));
    return { ok: true, content: added.join('\n'), applied: fp.hunks.length };
  }

  const lines = original.split('\n');
  let searchFrom = 0;
  let applied = 0;
  for (let hi = 0; hi < fp.hunks.length; hi++) {
    const hunk = fp.hunks[hi];
    const before = hunk.lines.filter(l => l.type !== '+').map(l => l.text);
    const after = hunk.lines.filter(l => l.type !== '-').map(l => l.text);
    const idx = findBlock(lines, before, hunk.oldStart - 1, searchFrom);
    if (idx < 0) {
      return {
        ok: false, content: original, applied,
        error: `hunk #${hi + 1} did not apply (its context was not found near line ${hunk.oldStart}). ` +
          `Re-read the file and regenerate the patch against its current contents.`,
      };
    }
    lines.splice(idx, before.length, ...after);
    searchFrom = idx + after.length;
    applied++;
  }
  return { ok: true, content: lines.join('\n'), applied };
}
