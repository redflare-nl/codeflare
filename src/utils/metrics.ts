import * as vscode from 'vscode';
import { log } from './logger';

/**
 * Per-turn metrics recorder. One JSON line per user turn is appended to
 * .codeflare/metrics.jsonl so a task can be replayed across models and compared
 * on the axes that matter for agentic performance: how much work it took (tool
 * calls, steps, rounds), how reliable it was (edit/verify/diagnostic failures),
 * how much it cost (tokens, wall-clock), and whether it needed the human
 * (interventions). The recorder only OBSERVES — it never changes the loop.
 */
export interface TurnMetrics {
  startedAt: number;
  model: string;
  provider: string;
  // Set only when an INDEPENDENT judge reviewed this turn ("provider:model").
  // Absent = the worker reviewed itself, which the report must not dress up.
  judgeModel?: string;
  // True when this model's measured over-claim record made a behavioural check
  // mandatory for the turn (see engine/calibration.ts).
  calibrationApplied?: boolean;
  rounds: number;              // _streamResponse invocations (fix-rounds included)
  steps: number;               // model calls across all rounds
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  editAttempts: number;        // create_file/edit_file/move_file/delete_file calls
  editFailures: number;        // those that reported an error (bad search, rejected, oversized)
  verifyRuns: number;
  verifyFailures: number;
  diagnosticErrors: number;    // new errors surfaced by the diagnostics rounds
  reviewFindings: number;      // problems the self-diff-review flagged
  humanInterventions: number;  // total human-in-the-loop events (sum of the breakdown)
  // Human involvement split so an agentic comparison isn't skewed by routine
  // approvals. approval = the user granted/was asked to gate an action (plan
  // review, confirmations); correction = the user vetoed/stopped/redirected the
  // agent (a real "it was going wrong" signal); clarification = the agent ended
  // a turn asking the human for missing information instead of acting.
  interventions: { approval: number; clarification: number; correction: number };
  // What VERIFICATION actually demonstrated, kept separate from `outcome` (which
  // is only what the model/loop did). 'clean' = a real check ran and the turn
  // settled green; 'failed' = the last check still failed; 'not-run' = nothing
  // was actually verified (so a 'completed' outcome is only the model's claim).
  verified: 'clean' | 'failed' | 'not-run';
  modelVerifyCommands: number; // build/test/typecheck commands the MODEL ran itself
  verifyRunsSkipped: number;   // gate re-runs skipped as already-verified & unchanged
  // Parallel-subagent telemetry (measure, don't tune): how much the feature is
  // used, whether tasks collided on the same file, and whether parallel paid off.
  subagentBatches: number;         // run_subagents(...) calls (parallel batches)
  subagentTasks: number;           // total subagent tasks across single + parallel
  subagentFileConflicts: number;   // files touched by >1 task in the same batch
  subagentTokens: number;          // completion tokens spent inside subagents
  subagentParallelMs: number;      // wall-clock summed across batches
  subagentSequentialMs: number;    // summed per-task time (parallel speedup = seq/parallel)
  promptTokens: number;        // summed across model calls (total processed)
  completionTokens: number;
  filesChanged: number;        // unique files mutated this turn
  outcome: 'completed' | 'stopped' | 'error' | 'incomplete';
}

export function newTurnMetrics(model: string, provider: string): TurnMetrics {
  return {
    startedAt: Date.now(),
    model, provider,
    rounds: 0, steps: 0, toolCalls: 0, toolCallsByName: {},
    editAttempts: 0, editFailures: 0, verifyRuns: 0, verifyFailures: 0,
    diagnosticErrors: 0, reviewFindings: 0, humanInterventions: 0,
    interventions: { approval: 0, clarification: 0, correction: 0 },
    verified: 'not-run', modelVerifyCommands: 0, verifyRunsSkipped: 0,
    subagentBatches: 0, subagentTasks: 0, subagentFileConflicts: 0,
    subagentTokens: 0, subagentParallelMs: 0, subagentSequentialMs: 0,
    promptTokens: 0, completionTokens: 0, filesChanged: 0,
    outcome: 'incomplete',
  };
}

// A build/test/typecheck/lint command — i.e. the kind of check the verify gate
// also runs. Used to MEASURE how often the model re-verifies by hand (potential
// duplicate work), not to block it.
const VERIFY_CMD_RE =
  /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck|type-check|build|lint)\b|\bnpx\s+tsc\b|\btsc\s+--noemit\b|\bpytest\b|\bpython\s+-m\s+(?:pytest|unittest|compileall|mypy|ruff|flake8)\b|\bgo\s+(?:test|build|vet)\b|\bcargo\s+(?:test|build|clippy)\b|\bdotnet\s+(?:test|build)\b|\bgradlew?\b|\bmvn\b|\bmake(?:\s+\w+)?\b|\b(?:eslint|prettier|vitest|jest|mocha|mypy|ruff|flake8)\b/i;

/** True if `command` is a build/test/typecheck-style verification the model ran itself. */
export function isVerifyLikeCommand(command: string): boolean {
  return VERIFY_CMD_RE.test(command || '');
}

const WRITE_TOOLS = new Set(['create_file', 'edit_file', 'move_file', 'delete_file', 'apply_patch', 'rename_symbol']);

/** True if a tool name mutates files (counts toward edit attempts). */
export function isMutatingTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

/**
 * Heuristic: does this tool result string read as a FAILED write? The write
 * tools return a leading "Created/Edited/Moved/Deleted …" on success and an
 * error sentence otherwise. Used to count edit failures and interventions.
 */
export function isWriteFailure(output: string): boolean {
  if (/^(Created|Edited|Moved|Deleted|Patched|Renamed)\b/.test(output)) { return false; }
  return /could not find the search snippet|search block too large|do not regenerate the whole file|already exists|does not exist|failed to (write|move|delete)|user (rejected|declined)|not applied|did not apply|hunk #|rename failed|no language-server rename/i
    .test(output);
}

/** True if the result indicates the user declined a confirmation. */
export function isUserDecline(output: string): boolean {
  return /user (rejected|declined)/i.test(output);
}

// Serializes the read-modify-write below. flushTurnMetrics is fire-and-forget
// (`void flushTurnMetrics(...)`) and the next turn can start before a flush
// finishes, so two flushes could otherwise both read the same file bytes and
// the second write would clobber the first turn's appended line. Chaining each
// write after the previous one guarantees they append in order.
let metricsWriteChain: Promise<void> = Promise.resolve();

/**
 * The last `limit` recorded turns (oldest first), for calibration. Malformed
 * lines are skipped; a missing file is an empty history. Never throws.
 */
export async function readTurnMetrics(limit = 200): Promise<Array<Partial<TurnMetrics> & { ts?: string; durationMs?: number }>> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) { return []; }
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, '.codeflare', 'metrics.jsonl'));
    const lines = new TextDecoder().decode(bytes).split('\n').filter(Boolean);
    const out: Array<Partial<TurnMetrics> & { ts?: string; durationMs?: number }> = [];
    for (const line of lines.slice(-limit)) {
      try { const rec = JSON.parse(line); if (rec && typeof rec === 'object') { out.push(rec); } } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** Append one turn's metrics to .codeflare/metrics.jsonl. Never throws. */
export async function flushTurnMetrics(m: TurnMetrics): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) { return; }
  // Keep the flat total in sync with the breakdown (back-compat for readers).
  m.humanInterventions = m.interventions.approval + m.interventions.clarification + m.interventions.correction;
  const record = {
    ts: new Date(m.startedAt).toISOString(),
    durationMs: Date.now() - m.startedAt,
    ...m,
  };
  const line = new TextEncoder().encode(JSON.stringify(record) + '\n');
  const dir = vscode.Uri.joinPath(root, '.codeflare');
  const file = vscode.Uri.joinPath(dir, 'metrics.jsonl');
  const task = metricsWriteChain.then(async () => {
    try {
      await vscode.workspace.fs.createDirectory(dir);
      let existing: Uint8Array = new Uint8Array();
      try { existing = await vscode.workspace.fs.readFile(file); } catch { /* first write */ }
      const merged = new Uint8Array(existing.length + line.length);
      merged.set(existing, 0);
      merged.set(line, existing.length);
      await vscode.workspace.fs.writeFile(file, merged);
      log(`Metrics: turn recorded (${m.toolCalls} tool calls, ${m.editFailures} edit fail, ` +
        `${m.verifyFailures} verify fail, ${record.durationMs}ms, outcome=${m.outcome})`);
    } catch (err: any) {
      log(`Metrics flush failed: ${err.message}`);
    }
  });
  // Keep the chain alive regardless of this write's outcome.
  metricsWriteChain = task.catch(() => { /* already logged */ });
  return task;
}
