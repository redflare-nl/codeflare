import * as vscode from 'vscode';
import { ChatViewProvider } from '../chat/chatViewProvider';
import { CodeAction } from '../llm/prompts';

export function registerCodeActions(
  context: vscode.ExtensionContext,
  chatProvider: ChatViewProvider
): void {
  const actions: Array<[string, CodeAction]> = [
    ['codeflare.explainCode', 'explain'],
    ['codeflare.refactorCode', 'refactor'],
    ['codeflare.fixBug', 'fix'],
    ['codeflare.addTests', 'test'],
    ['codeflare.documentCode', 'document'],
  ];

  for (const [commandId, action] of actions) {
    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('No active editor');
          return;
        }

        const selection = editor.selection;
        const text = editor.document.getText(selection);
        if (!text) {
          vscode.window.showWarningMessage('No code selected');
          return;
        }

        const filePath = vscode.workspace.asRelativePath(editor.document.uri);
        const language = editor.document.languageId;

        // Focus the chat panel
        vscode.commands.executeCommand('codeflare.chatView.focus');

        // Send the action
        chatProvider.sendCodeAction(action, text, filePath, language);
      })
    );
  }
}
