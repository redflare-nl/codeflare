import * as vscode from 'vscode';
import { recordPreMutation } from './checkpoint';
import { invalidateRepoMap } from './repoMap';
import { invalidateStacks } from '../stacks/stacks';
import { log } from '../utils/logger';
import { gateMutation, previewMutation } from '../engine/policyGate';
import { policyMessage } from '../engine/policy';

/**
 * Semantic navigation via the workspace's language servers (LSP), instead of
 * plain-text search: find where a symbol is defined/used, and list a file's
 * symbols. Returns formatted text for the agent. Also a semantic EDIT — a
 * language-server rename that updates every reference across files correctly.
 */

function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function kindName(k: vscode.SymbolKind): string {
  return vscode.SymbolKind[k] ?? String(k);
}

export async function findSymbol(query: string): Promise<string> {
  if (!query) { return 'Empty symbol query.'; }
  const syms = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    'vscode.executeWorkspaceSymbolProvider', query
  )) || [];
  if (syms.length === 0) { return `No symbols matching "${query}".`; }

  const lines = syms.slice(0, 40).map(s => {
    const rel = vscode.workspace.asRelativePath(s.location.uri);
    const line = s.location.range.start.line + 1;
    const container = s.containerName ? ` (in ${s.containerName})` : '';
    return `${kindName(s.kind)} ${s.name}${container} — ${rel}:${line}`;
  });
  const note = syms.length > 40 ? `\n… (${syms.length - 40} more)` : '';
  return `Symbols matching "${query}":\n${lines.join('\n')}${note}`;
}

export async function documentSymbols(relPath: string): Promise<string> {
  const root = workspaceRoot();
  if (!root) { return 'No workspace folder is open.'; }
  const uri = vscode.Uri.joinPath(root, relPath.replace(/\\/g, '/'));

  const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider', uri
  );
  if (!syms || syms.length === 0) {
    return `No symbols found in ${relPath} (no language server for this file type, or it's empty).`;
  }

  const out: string[] = [];
  const walk = (arr: vscode.DocumentSymbol[], depth: number) => {
    for (const s of arr) {
      out.push(`${'  '.repeat(depth)}${kindName(s.kind)} ${s.name} — line ${s.range.start.line + 1}`);
      if (s.children && s.children.length) { walk(s.children, depth + 1); }
    }
  };
  walk(syms, 0);
  return `Symbols in ${relPath}:\n${out.slice(0, 200).join('\n')}`;
}

async function locateSymbol(uri: vscode.Uri, symbol: string): Promise<{ doc: vscode.TextDocument; pos: vscode.Position } | string> {
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (err: any) {
    return `Cannot open file: ${err.message}`;
  }
  const idx = doc.getText().indexOf(symbol);
  if (idx < 0) { return `"${symbol}" does not appear in that file.`; }
  // Point at the middle of the identifier so the provider resolves it.
  return { doc, pos: doc.positionAt(idx + Math.floor(symbol.length / 2)) };
}

export async function findReferences(relPath: string, symbol: string): Promise<string> {
  const root = workspaceRoot();
  if (!root) { return 'No workspace folder is open.'; }
  const uri = vscode.Uri.joinPath(root, relPath.replace(/\\/g, '/'));

  const loc = await locateSymbol(uri, symbol);
  if (typeof loc === 'string') { return loc; }

  const refs = (await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeReferenceProvider', uri, loc.pos
  )) || [];
  if (refs.length === 0) { return `No references found for "${symbol}".`; }

  const lines = refs.slice(0, 60).map(l =>
    `${vscode.workspace.asRelativePath(l.uri)}:${l.range.start.line + 1}`
  );
  const note = refs.length > 60 ? `\n… (${refs.length - 60} more)` : '';
  return `References to "${symbol}" (${refs.length}):\n${lines.join('\n')}${note}`;
}

/**
 * Rename a symbol everywhere it's used, via the language server — the correct,
 * whole-workspace refactor that plain search/replace cannot do safely. Captures
 * each affected file in the turn checkpoint before applying, so it's undoable.
 */
export async function renameSymbol(relPath: string, symbol: string, newName: string): Promise<string> {
  const root = workspaceRoot();
  if (!root) { return 'No workspace folder is open.'; }
  if (!newName || !/^[A-Za-z_$][\w$]*$/.test(newName)) {
    return `Invalid new name "${newName}". Use a valid identifier.`;
  }
  const uri = vscode.Uri.joinPath(root, relPath.replace(/\\/g, '/'));

  const loc = await locateSymbol(uri, symbol);
  if (typeof loc === 'string') { return loc; }

  let edit: vscode.WorkspaceEdit | undefined;
  try {
    edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      'vscode.executeDocumentRenameProvider', uri, loc.pos, newName
    );
  } catch (err: any) {
    return `Rename failed: ${err.message}. Use edit_file or apply_patch instead.`;
  }
  if (!edit || edit.size === 0) {
    return `No language-server rename available for "${symbol}" here (no rename provider, or nothing to rename). ` +
      `Use edit_file or apply_patch instead.`;
  }

  // Deterministic policy preflight: if ANY affected file is off-limits, apply
  // nothing (a rename must stay atomic).
  const entries = edit.entries();
  for (const [fileUri] of entries) {
    const rel = vscode.workspace.asRelativePath(fileUri);
    const verdict = previewMutation(rel);
    if (!verdict.allowed) {
      return `Rename not applied — it would touch "${rel}". ${policyMessage(verdict)}`;
    }
  }

  // Capture every file the rename touches BEFORE applying, so the turn revert
  // can restore them; then apply and persist.
  let occurrences = 0;
  for (const [fileUri, edits] of entries) {
    occurrences += edits.length;
    const rel = vscode.workspace.asRelativePath(fileUri);
    gateMutation(rel);   // record into the budget totals (previewed above)
    await recordPreMutation(rel);
  }

  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) { return `The language server rejected the rename of "${symbol}".`; }

  // applyEdit changes the in-memory documents; save them to write to disk.
  const saved: string[] = [];
  for (const [fileUri] of entries) {
    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      if (doc.isDirty) { await doc.save(); }
      saved.push(vscode.workspace.asRelativePath(fileUri));
    } catch { /* best-effort save */ }
  }
  invalidateRepoMap();
  invalidateStacks();
  log(`Renamed symbol "${symbol}" → "${newName}" in ${entries.length} file(s), ${occurrences} occurrence(s)`);
  return `Renamed "${symbol}" to "${newName}" across ${entries.length} file(s) ` +
    `(${occurrences} occurrence(s)): ${saved.join(', ')}.`;
}

export async function findDefinition(relPath: string, symbol: string): Promise<string> {
  const root = workspaceRoot();
  if (!root) { return 'No workspace folder is open.'; }
  const uri = vscode.Uri.joinPath(root, relPath.replace(/\\/g, '/'));

  const loc = await locateSymbol(uri, symbol);
  if (typeof loc === 'string') { return loc; }

  const defs = (await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeDefinitionProvider', uri, loc.pos
  )) || [];
  if (defs.length === 0) { return `No definition found for "${symbol}".`; }

  const lines = defs.slice(0, 20).map(d => {
    const u = 'targetUri' in d ? d.targetUri : d.uri;
    const range = 'targetRange' in d ? d.targetRange : d.range;
    return `${vscode.workspace.asRelativePath(u)}:${range.start.line + 1}`;
  });
  return `Definition of "${symbol}":\n${lines.join('\n')}`;
}
