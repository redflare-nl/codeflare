import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

// Ring buffer of recent log lines so the chat's "copy log" button can include
// the extension-side diagnostics without opening the Output panel.
const MAX_RECENT = 500;
const recent: string[] = [];

export function getLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('CodeFlare');
  }
  return channel;
}

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  getLogger().appendLine(line);
  recent.push(line);
  if (recent.length > MAX_RECENT) { recent.splice(0, recent.length - MAX_RECENT); }
}

export function getRecentLog(): string[] {
  return [...recent];
}
