/**
 * Run history persistence — the replay foundation.
 *
 *  - One chronological JSONL file per turn under .codeflare/runs/ (tool calls,
 *    evidence, gate outcomes, decision). Entries are buffered in memory and
 *    flushed once at turn end (plus on error), so a chatty turn costs one
 *    write, not hundreds of read-modify-writes.
 *  - One appended line per finished experiment in .codeflare/experiments.jsonl
 *    (same append-chain pattern as metrics.jsonl).
 *
 * Entries record labels and sizes, not payloads — the run log is for
 * inspection ("what happened, in what order, with what result"), not for
 * re-feeding content. Payload-bearing artifacts stay where they are and are
 * referenced by path.
 */

import * as vscode from 'vscode';
import { log } from '../utils/logger';
import { ExperimentRecord } from './experiment';

export interface RunLogEntry {
  ts: number;
  kind: 'turn-start' | 'step' | 'tool' | 'evidence' | 'gate' | 'round' | 'plan' | 'decision' | 'note';
  [key: string]: unknown;
}

const MAX_ENTRIES = 2000;   // runaway-loop backstop; a normal turn is < 200

export class TurnRunLog {
  readonly id: string;
  private entries: RunLogEntry[] = [];
  private flushed = false;

  constructor(taskPreview: string, model: string, provider: string) {
    this.id = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    this.append('turn-start', { task: taskPreview.slice(0, 300), model, provider });
  }

  append(kind: RunLogEntry['kind'], data: Record<string, unknown> = {}): void {
    if (this.entries.length >= MAX_ENTRIES) { return; }
    this.entries.push({ ts: Date.now(), kind, ...data });
  }

  /** Write the whole run once. Safe to call twice; the second call is a no-op. */
  async flush(): Promise<void> {
    if (this.flushed || this.entries.length <= 1) { return; }
    this.flushed = true;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) { return; }
    try {
      const dir = vscode.Uri.joinPath(root, '.codeflare', 'runs');
      await vscode.workspace.fs.createDirectory(dir);
      const file = vscode.Uri.joinPath(dir, `${this.id}.jsonl`);
      const body = this.entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(body));
    } catch (err: any) {
      log(`Run log flush failed: ${err.message}`);
    }
  }
}

// Serializes appends the same way metrics.jsonl does: fire-and-forget callers
// could otherwise interleave read-modify-write cycles and lose lines.
let experimentWriteChain: Promise<void> = Promise.resolve();

/** Append one finished experiment to .codeflare/experiments.jsonl. Never throws. */
export async function appendExperiment(record: ExperimentRecord): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) { return; }
  const line = new TextEncoder().encode(JSON.stringify(record) + '\n');
  const dir = vscode.Uri.joinPath(root, '.codeflare');
  const file = vscode.Uri.joinPath(dir, 'experiments.jsonl');
  const task = experimentWriteChain.then(async () => {
    try {
      await vscode.workspace.fs.createDirectory(dir);
      let existing: Uint8Array = new Uint8Array();
      try { existing = await vscode.workspace.fs.readFile(file); } catch { /* first write */ }
      const merged = new Uint8Array(existing.length + line.length);
      merged.set(existing, 0);
      merged.set(line, existing.length);
      await vscode.workspace.fs.writeFile(file, merged);
      log(`Experiment recorded: ${record.id} → ${record.decision ?? record.state}`);
    } catch (err: any) {
      log(`Experiment append failed: ${err.message}`);
    }
  });
  experimentWriteChain = task.catch(() => { /* already logged */ });
  return task;
}
