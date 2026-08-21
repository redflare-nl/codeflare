import * as vscode from 'vscode';

/**
 * Collects editor diagnostics (errors/warnings) for the files the agent just
 * wrote, so the agent can be asked to fix them. Files that aren't open won't
 * have diagnostics yet, so we open them (without showing) to trigger the
 * language server, then wait briefly for results to settle.
 */

export interface DiagReport {
  errorCount: number;
  warningCount: number;
  text: string;
}

function severityLabel(sev: vscode.DiagnosticSeverity): string {
  return sev === vscode.DiagnosticSeverity.Error ? 'error'
    : sev === vscode.DiagnosticSeverity.Warning ? 'warning'
    : sev === vscode.DiagnosticSeverity.Information ? 'info' : 'hint';
}

/** Wait until diagnostics for the target URIs stop changing, or a timeout. */
function waitForDiagnostics(uris: vscode.Uri[], timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    const targets = new Set(uris.map(u => u.toString()));
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (settleTimer) { clearTimeout(settleTimer); }
      clearTimeout(hardTimeout);
      sub.dispose();
      resolve();
    };

    const sub = vscode.languages.onDidChangeDiagnostics(e => {
      if (e.uris.some(u => targets.has(u.toString()))) {
        if (settleTimer) { clearTimeout(settleTimer); }
        // Resolve shortly after the last relevant change (a quiet period).
        settleTimer = setTimeout(finish, 400);
      }
    });

    const hardTimeout = setTimeout(finish, timeoutMs);
  });
}

/** Stable signature for one diagnostic, for baseline/regression comparison. */
function diagSignature(uri: vscode.Uri, d: vscode.Diagnostic): string {
  return `${uri.toString()}::${d.range.start.line}::${d.message}`;
}

/**
 * Snapshot the signatures of every error currently known across the workspace.
 * Taken at the START of a turn so the verify step can later report only the
 * errors the turn INTRODUCED — including in files the agent never opened
 * (regressions) — instead of pre-existing ones that are out of scope.
 */
export function snapshotErrorSignatures(): Set<string> {
  const sigs = new Set<string>();
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    for (const d of diags) {
      if (d.severity === vscode.DiagnosticSeverity.Error) { sigs.add(diagSignature(uri, d)); }
    }
  }
  return sigs;
}

/**
 * Errors that are NEW relative to `baseline` — the regressions this turn caused.
 * The written files are opened first (to force their language server to
 * re-analyze), then the whole workspace is scanned so a change that breaks an
 * untouched file is caught too. Files not in `writtenPaths` are flagged as
 * regressions in the report text.
 */
export async function collectNewErrors(
  writtenPaths: string[],
  baseline: Set<string>,
  timeoutMs = 2000
): Promise<DiagReport> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) { return { errorCount: 0, warningCount: 0, text: '' }; }

  const writtenUris = writtenPaths.map(p => vscode.Uri.joinPath(root, p.replace(/\\/g, '/')));
  const writtenSet = new Set(writtenUris.map(u => u.toString()));

  await Promise.all(writtenUris.map(async u => {
    try { await vscode.workspace.openTextDocument(u); } catch { /* ignore */ }
  }));
  await waitForDiagnostics(writtenUris, timeoutMs);

  let errorCount = 0;
  const lines: string[] = [];
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    for (const d of diags) {
      if (d.severity !== vscode.DiagnosticSeverity.Error) { continue; }
      if (baseline.has(diagSignature(uri, d))) { continue; }
      errorCount++;
      if (lines.length >= 30) { continue; }
      const rel = vscode.workspace.asRelativePath(uri);
      const regression = !writtenSet.has(uri.toString()) ? ' (regression — a file you did not edit)' : '';
      lines.push(
        `${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ` +
        `[error]${regression} ${d.message}${d.source ? ` (${d.source})` : ''}`
      );
    }
  }
  if (errorCount > 30) { lines.push(`… (${errorCount - 30} more new error(s))`); }

  return { errorCount, warningCount: 0, text: lines.join('\n') };
}

export async function collectDiagnostics(
  relPaths: string[],
  timeoutMs = 1800
): Promise<DiagReport> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root || relPaths.length === 0) {
    return { errorCount: 0, warningCount: 0, text: '' };
  }

  const uris = relPaths.map(p => vscode.Uri.joinPath(root, p.replace(/\\/g, '/')));

  // Open each file so the language server analyzes it (no-op if already open).
  await Promise.all(uris.map(async u => {
    try { await vscode.workspace.openTextDocument(u); } catch { /* ignore */ }
  }));

  await waitForDiagnostics(uris, timeoutMs);

  let errorCount = 0;
  let warningCount = 0;
  const lines: string[] = [];

  for (const u of uris) {
    const diags = vscode.languages
      .getDiagnostics(u)
      .filter(d => d.severity <= vscode.DiagnosticSeverity.Warning)
      .slice(0, 20);
    if (diags.length === 0) { continue; }

    const rel = vscode.workspace.asRelativePath(u);
    for (const d of diags) {
      if (d.severity === vscode.DiagnosticSeverity.Error) { errorCount++; }
      else { warningCount++; }
      lines.push(
        `${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ` +
        `[${severityLabel(d.severity)}] ${d.message}${d.source ? ` (${d.source})` : ''}`
      );
    }
  }

  return { errorCount, warningCount, text: lines.join('\n') };
}
