import * as vscode from 'vscode';
import * as path from 'path';
import { log } from '../utils/logger';

export interface EditBlock {
  search: string;
  replace: string;
}

export interface EditResult {
  newContent: string;
  applied: number;
  failed: number;
  errors: string[];
}

const EDIT_REGEX = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;

export function hasEditBlocks(text: string): boolean {
  return text.includes('<<<<<<< SEARCH') && text.includes('>>>>>>> REPLACE');
}

export function parseEditBlocks(text: string): EditBlock[] {
  const blocks: EditBlock[] = [];
  const regex = new RegExp(EDIT_REGEX.source, 'g');
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      search: match[1],
      replace: match[2],
    });
  }
  return blocks;
}

export function applyEdits(code: string, blocks: EditBlock[]): EditResult {
  let result = code;
  let applied = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const block of blocks) {
    // Try exact match first. Use a replacer FUNCTION so the replacement is
    // inserted literally — a plain-string 2nd arg would let JS interpret $&, $$,
    // $`, $' inside model/user code (e.g. Makefile `$$var`, a regex `$&`),
    // silently corrupting the written file.
    if (result.includes(block.search)) {
      result = result.replace(block.search, () => block.replace);
      applied++;
      continue;
    }

    // Try trimmed whitespace match (indent differences)
    const searchLines = block.search.split('\n').map(l => l.trim());
    const codeLines = result.split('\n');
    let found = false;

    for (let i = 0; i <= codeLines.length - searchLines.length; i++) {
      let isMatch = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (codeLines[i + j].trim() !== searchLines[j]) {
          isMatch = false;
          break;
        }
      }
      if (isMatch) {
        // Preserve the indentation of the first matched line
        const indentMatch = codeLines[i].match(/^(\s*)/);
        const indent = indentMatch ? indentMatch[1] : '';
        const origFirstIndentMatch = block.replace.split('\n')[0].match(/^(\s*)/);
        const origIndent = origFirstIndentMatch ? origFirstIndentMatch[1] : '';

        const replaceLines = block.replace.split('\n').map((l, idx) => {
          if (idx === 0) { return indent + l.trim(); }
          // Strip at most the line's OWN leading whitespace. A line indented
          // less than the first replacement line (a dedent — a closing brace,
          // end of block) would otherwise have real characters chopped off by
          // substring(origIndent.length), silently deleting code.
          const lead = (l.match(/^\s*/) || [''])[0];
          const relIndent = l.substring(Math.min(origIndent.length, lead.length));
          return indent + relIndent;
        });

        codeLines.splice(i, searchLines.length, ...replaceLines);
        result = codeLines.join('\n');
        applied++;
        found = true;
        break;
      }
    }

    if (!found) {
      failed++;
      const preview = block.search.split('\n')[0].substring(0, 60);
      errors.push(`Could not find: "${preview}..."`);
    }
  }

  return { newContent: result, applied, failed, errors };
}

export function extractExplanation(text: string): string {
  return text
    .replace(/<<<<<<< SEARCH\n[\s\S]*?>>>>>>> REPLACE/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Content provider for showing modified file in diff view
export class EditPreviewContentProvider implements vscode.TextDocumentContentProvider {
  private content = new Map<string, string>();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  setContent(uri: vscode.Uri, text: string): void {
    this.content.set(uri.toString(), text);
    this._onDidChange.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? '';
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

let previewProvider: EditPreviewContentProvider | undefined;

export function getPreviewProvider(): EditPreviewContentProvider {
  if (!previewProvider) {
    previewProvider = new EditPreviewContentProvider();
  }
  return previewProvider;
}

export async function applyEditsWithDiff(
  document: vscode.TextDocument,
  blocks: EditBlock[]
): Promise<{ applied: number; failed: number } | null> {
  const original = document.getText();
  const result = applyEdits(original, blocks);

  if (result.applied === 0) {
    vscode.window.showErrorMessage(
      `Could not apply any edits. ${result.errors.join('; ')}`
    );
    return null;
  }

  if (result.failed > 0) {
    vscode.window.showWarningMessage(
      `Applied ${result.applied}/${blocks.length} edits. ${result.failed} failed: ${result.errors.join('; ')}`
    );
  }

  // Show diff and ask for confirmation
  const provider = getPreviewProvider();
  const previewUri = vscode.Uri.parse(
    `codeflare-preview:${document.uri.path}?modified`
  );
  provider.setContent(previewUri, result.newContent);

  await vscode.commands.executeCommand(
    'vscode.diff',
    document.uri,
    previewUri,
    `${path.basename(document.uri.fsPath)}: CodeFlare Edit Preview`
  );

  const accepted = await vscode.window.showInformationMessage(
    `${result.applied} edit(s) ready to apply. Accept changes?`,
    'Accept',
    'Reject'
  );

  if (accepted === 'Accept') {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
      result.newContent
    );
    await vscode.workspace.applyEdit(edit);
    log(`Applied ${result.applied} edit(s) to ${document.uri.fsPath}`);
    vscode.window.showInformationMessage(`Applied ${result.applied} edit(s)`);
  }

  // Close the diff editor
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  return { applied: result.applied, failed: result.failed };
}
