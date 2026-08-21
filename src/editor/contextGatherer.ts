import * as vscode from 'vscode';
import { getConfig } from '../utils/config';

export interface DiagnosticInfo {
  severity: string;
  message: string;
  line: number;
  source?: string;
}

export interface FileContext {
  path: string;
  language: string;
  excerpt: string;
}

// Below this size the whole active file is embedded in the prompt; above it,
// only a head excerpt goes in and the model pulls the rest with read_file on
// demand — so a trivial question doesn't ship the entire file every turn.
const ACTIVE_FILE_FULL_MAX_CHARS = 6000;
const ACTIVE_FILE_HEAD_LINES = 40;

export interface EditorContext {
  activeFile?: {
    path: string;
    language: string;
    content: string;
    totalLines: number;
    truncated: boolean;
    selection?: {
      text: string;
      startLine: number;
      endLine: number;
      surroundingBefore: string;
      surroundingAfter: string;
    };
    diagnostics: DiagnosticInfo[];
  };
  openFiles: FileContext[];
}

// The chat lives in a webview panel. While it has focus,
// vscode.window.activeTextEditor is undefined — so without tracking, the agent
// loses sight of the file the user was just editing the moment they click into
// the chat. Remember the last real file editor and fall back to it.
let lastActiveEditor: vscode.TextEditor | undefined;

/** Subscribe to editor focus changes so we always know the user's last file. */
export function registerActiveEditorTracker(context: vscode.ExtensionContext): void {
  if (vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
    lastActiveEditor = vscode.window.activeTextEditor;
  }
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      // Ignore focus moving to the chat webview (reports no editor) or to
      // non-file docs (output panels, previews) — keep the last real file.
      if (editor?.document.uri.scheme === 'file') {
        lastActiveEditor = editor;
      }
    })
  );
}

/**
 * The editor whose file the agent should treat as "current": the active one if
 * it's a real file, otherwise the last file editor the user worked in (as long
 * as it's still open), otherwise any visible file editor.
 */
export function resolveActiveEditor(): vscode.TextEditor | undefined {
  const active = vscode.window.activeTextEditor;
  if (active?.document.uri.scheme === 'file') { return active; }

  const visible = vscode.window.visibleTextEditors.filter(
    e => e.document.uri.scheme === 'file'
  );
  if (lastActiveEditor && !lastActiveEditor.document.isClosed) {
    const key = lastActiveEditor.document.uri.toString();
    return visible.find(e => e.document.uri.toString() === key) ?? lastActiveEditor;
  }
  return visible[0];
}

function getSeverityString(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error: return 'error';
    case vscode.DiagnosticSeverity.Warning: return 'warning';
    case vscode.DiagnosticSeverity.Information: return 'info';
    case vscode.DiagnosticSeverity.Hint: return 'hint';
  }
}

function getFileExcerpt(document: vscode.TextDocument, maxLines: number = 15): string {
  const totalLines = document.lineCount;
  if (totalLines <= maxLines) {
    return document.getText();
  }
  const headLines = Math.ceil(maxLines * 0.7);
  const tailLines = maxLines - headLines;
  const head = document.getText(new vscode.Range(0, 0, headLines, 0));
  const tail = document.getText(new vscode.Range(totalLines - tailLines, 0, totalLines, 0));
  return `${head}\n// ... (${totalLines - maxLines} lines omitted) ...\n${tail}`;
}

export function gatherContext(): EditorContext {
  const config = getConfig();
  const ctx: EditorContext = { openFiles: [] };
  let charBudget = config.maxContextChars;

  const editor = resolveActiveEditor();
  if (!editor) { return ctx; }

  const doc = editor.document;
  const fullContent = doc.getText();
  const filePath = vscode.workspace.asRelativePath(doc.uri);

  // Embed the whole file only when it's small; for a larger file send just a
  // head excerpt and let the model read the rest with read_file when it needs
  // it. Keeps the per-turn prompt small without losing small files from context.
  const totalLines = doc.lineCount;
  let embedded: string;
  let truncated = false;
  if (fullContent.length <= Math.min(ACTIVE_FILE_FULL_MAX_CHARS, charBudget)) {
    embedded = fullContent;
  } else {
    const head = new vscode.Range(0, 0, Math.min(ACTIVE_FILE_HEAD_LINES, totalLines), 0);
    embedded = doc.getText(head).replace(/\n$/, '');
    truncated = true;
  }

  const activeFile: EditorContext['activeFile'] = {
    path: filePath,
    language: doc.languageId,
    content: embedded,
    totalLines,
    truncated,
    diagnostics: [],
  };
  charBudget -= embedded.length;

  // Selection with surrounding context
  const selection = editor.selection;
  if (!selection.isEmpty) {
    const selectedText = doc.getText(selection);
    const startLine = Math.max(0, selection.start.line - config.contextLines);
    const endLine = Math.min(doc.lineCount - 1, selection.end.line + config.contextLines);

    const beforeRange = new vscode.Range(startLine, 0, selection.start.line, 0);
    const afterRange = new vscode.Range(selection.end.line + 1, 0, endLine + 1, 0);

    activeFile.selection = {
      text: selectedText,
      startLine: selection.start.line + 1,
      endLine: selection.end.line + 1,
      surroundingBefore: doc.getText(beforeRange),
      surroundingAfter: doc.getText(afterRange),
    };
  }

  // Diagnostics (errors and warnings). Sort by severity BEFORE the slice —
  // getDiagnostics returns them in document order, so without this a file with
  // many early warnings could push the one real error out of the 10-item budget.
  const diagnostics = vscode.languages.getDiagnostics(doc.uri);
  activeFile.diagnostics = diagnostics
    .filter(d => d.severity <= vscode.DiagnosticSeverity.Warning)
    .sort((a, b) => a.severity - b.severity)
    .slice(0, 10)
    .map(d => ({
      severity: getSeverityString(d.severity),
      message: d.message,
      line: d.range.start.line + 1,
      source: d.source,
    }));

  ctx.activeFile = activeFile;

  // Open editor tabs (excluding active file)
  if (charBudget > 0) {
    const openDocs = vscode.workspace.textDocuments.filter(
      d => d.uri.scheme === 'file' && d.uri.toString() !== doc.uri.toString()
    );

    let filesAdded = 0;
    for (const openDoc of openDocs) {
      if (filesAdded >= config.maxContextFiles || charBudget <= 0) { break; }

      const excerpt = getFileExcerpt(openDoc);
      if (excerpt.length > charBudget) { continue; }

      ctx.openFiles.push({
        path: vscode.workspace.asRelativePath(openDoc.uri),
        language: openDoc.languageId,
        excerpt,
      });
      charBudget -= excerpt.length;
      filesAdded++;
    }
  }

  return ctx;
}

export function buildContextString(ctx: EditorContext): string {
  let parts: string[] = [];

  if (ctx.activeFile) {
    const af = ctx.activeFile;
    if (af.truncated) {
      const shown = af.content.split('\n').length;
      parts.push(`CURRENT FILE: ${af.path} (${af.language}) — first ${shown} of ${af.totalLines} lines shown; ` +
        `call read_file("${af.path}") for the full contents before editing.`);
    } else {
      parts.push(`CURRENT FILE: ${af.path} (${af.language})`);
    }
    parts.push('```' + af.language);
    parts.push(af.content);
    parts.push('```');

    if (af.selection) {
      parts.push(`\nSELECTED CODE (lines ${af.selection.startLine}-${af.selection.endLine}):`);
      parts.push('```' + af.language);
      parts.push(af.selection.text);
      parts.push('```');
    }

    if (af.diagnostics.length > 0) {
      parts.push('\nDIAGNOSTICS:');
      for (const d of af.diagnostics) {
        parts.push(`- [${d.severity}] Line ${d.line}: ${d.message}${d.source ? ` (${d.source})` : ''}`);
      }
    }
  }

  if (ctx.openFiles.length > 0) {
    parts.push('\nOTHER OPEN FILES:');
    for (const f of ctx.openFiles) {
      parts.push(`\n--- ${f.path} (${f.language}) ---`);
      parts.push('```' + f.language);
      parts.push(f.excerpt);
      parts.push('```');
    }
  }

  return parts.join('\n');
}
