import * as vscode from 'vscode';
import { log } from './logger';

/**
 * Model-comparison report over .codeflare/metrics.jsonl (written by the per-turn
 * metrics recorder). This is the reading half of the benchmark loop: run the
 * same task with different models, then compare them here on the axes that
 * matter for agentic work — effort (steps/tool calls), reliability (edit/verify
 * failure rates), autonomy (human interventions), cost (tokens, wall-clock).
 * Aggregation is per model; the report opens as a markdown document.
 */

interface Agg {
  model: string;
  provider: string;
  turns: number;
  outcomes: Record<string, number>;
  steps: number;
  toolCalls: number;
  editAttempts: number;
  editFailures: number;
  verifyRuns: number;
  verifyFailures: number;
  verifyRunsSkipped: number;
  modelVerifyCommands: number;
  diagnosticErrors: number;
  reviewFindings: number;
  humanInterventions: number;
  approvals: number;
  clarifications: number;
  corrections: number;
  // What verification actually demonstrated, per turn (separate from `outcome`).
  verifiedClean: number;
  verifiedFailed: number;
  verifiedNotRun: number;
  subagentBatches: number;
  subagentTasks: number;
  subagentFileConflicts: number;
  subagentTokens: number;
  subagentParallelMs: number;
  subagentSequentialMs: number;
  promptTokens: number;
  completionTokens: number;
  filesChanged: number;
  durationMs: number;
}

function emptyAgg(model: string, provider: string): Agg {
  return {
    model, provider, turns: 0, outcomes: {}, steps: 0, toolCalls: 0,
    editAttempts: 0, editFailures: 0, verifyRuns: 0, verifyFailures: 0,
    verifyRunsSkipped: 0, modelVerifyCommands: 0,
    diagnosticErrors: 0, reviewFindings: 0, humanInterventions: 0,
    approvals: 0, clarifications: 0, corrections: 0,
    verifiedClean: 0, verifiedFailed: 0, verifiedNotRun: 0,
    subagentBatches: 0, subagentTasks: 0, subagentFileConflicts: 0,
    subagentTokens: 0, subagentParallelMs: 0, subagentSequentialMs: 0,
    promptTokens: 0, completionTokens: 0, filesChanged: 0, durationMs: 0,
  };
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
}
function avg(sum: number, n: number, digits = 1): string {
  return n > 0 ? (sum / n).toFixed(digits) : '—';
}
function fmtDuration(ms: number): string {
  if (ms < 1000) { return `${Math.round(ms)}ms`; }
  const s = ms / 1000;
  return s < 90 ? `${s.toFixed(1)}s` : `${(s / 60).toFixed(1)}min`;
}

function buildReport(aggs: Agg[], totalTurns: number, skipped: number): string {
  const lines: string[] = [];
  lines.push('# CodeFlare metrics — model comparison');
  lines.push('');
  lines.push(`${totalTurns} recorded turn(s) in \`.codeflare/metrics.jsonl\`` +
    (skipped ? ` (${skipped} malformed line(s) skipped)` : '') + '.');
  lines.push('');
  lines.push('| Model | Turns | Claimed done | Verified✓ | Avg steps | Avg tool calls | Edit fail | Verify fail | Corrections | Avg tokens (in/out) | Avg duration |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const a of aggs) {
    const completed = a.outcomes['completed'] || 0;
    lines.push(`| ${a.model} (${a.provider}) | ${a.turns} | ${completed}/${a.turns} ` +
      `| ${a.verifiedClean}/${a.turns} ` +
      `| ${avg(a.steps, a.turns)} | ${avg(a.toolCalls, a.turns)} ` +
      `| ${pct(a.editFailures, a.editAttempts)} (${a.editFailures}/${a.editAttempts}) ` +
      `| ${pct(a.verifyFailures, a.verifyRuns)} (${a.verifyFailures}/${a.verifyRuns}) ` +
      `| ${a.corrections} ` +
      `| ${avg(a.promptTokens, a.turns, 0)}/${avg(a.completionTokens, a.turns, 0)} ` +
      `| ${a.turns ? fmtDuration(a.durationMs / a.turns) : '—'} |`);
  }
  lines.push('');
  lines.push('## Per-model detail');
  for (const a of aggs) {
    lines.push('');
    lines.push(`### ${a.model} (${a.provider})`);
    const outcomes = Object.entries(a.outcomes).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none';
    lines.push(`- Outcomes: ${outcomes}`);
    lines.push(`- Effort: ${avg(a.steps, a.turns)} steps and ${avg(a.toolCalls, a.turns)} tool calls per turn; ` +
      `${avg(a.filesChanged, a.turns)} file(s) changed per turn`);
    lines.push(`- Outcome vs verification: model CLAIMED done ${a.outcomes['completed'] || 0}/${a.turns}, ` +
      `but verification DEMONSTRATED clean ${a.verifiedClean}/${a.turns} ` +
      `(failed ${a.verifiedFailed}, not-verified ${a.verifiedNotRun}). ` +
      `A gap here = "said done" without a check actually proving it.`);
    lines.push(`- Reliability: edit failures ${a.editFailures}/${a.editAttempts} (${pct(a.editFailures, a.editAttempts)}), ` +
      `verify failures ${a.verifyFailures}/${a.verifyRuns} (${pct(a.verifyFailures, a.verifyRuns)}), ` +
      `${a.diagnosticErrors} diagnostic error(s), ${a.reviewFindings} diff-review finding(s)`);
    lines.push(`- Autonomy: ${a.corrections} correction(s) (vetoed/stopped), ${a.approvals} approval(s), ` +
      `${a.clarifications} clarification(s) across ${a.turns} turn(s)`);
    lines.push(`- Duplicate verification: model ran ${a.modelVerifyCommands} build/test command(s) itself ` +
      `vs ${a.verifyRuns} gate run(s); ${a.verifyRunsSkipped} gate run(s) skipped as already-verified. ` +
      `High model-run counts next to gate runs = the same check done twice.`);
    if (a.subagentTasks > 0) {
      const speedup = a.subagentParallelMs > 0 ? (a.subagentSequentialMs / a.subagentParallelMs).toFixed(1) + '×' : '—';
      lines.push(`- Subagents: ${a.subagentTasks} task(s) in ${a.subagentBatches} parallel batch(es), ` +
        `${a.subagentFileConflicts} same-file conflict(s), ~${a.subagentTokens} completion tokens; ` +
        `parallel speedup ${speedup} (seq ${fmtDuration(a.subagentSequentialMs)} vs wall ${fmtDuration(a.subagentParallelMs)}). ` +
        `Speedup near 1× or conflicts > 0 mean parallel isn't paying off.`);
    }
    lines.push(`- Cost: ~${avg(a.promptTokens, a.turns, 0)} prompt + ${avg(a.completionTokens, a.turns, 0)} ` +
      `completion tokens per turn; ${a.turns ? fmtDuration(a.durationMs / a.turns) : '—'} average wall-clock`);
  }
  lines.push('');
  lines.push('_To benchmark: run the SAME task with different models (switch the model in the panel), ' +
    'then rerun this report. "Claimed done" is what the model said; "Verified✓" is what a real check proved — ' +
    'compare the two. Lower effort/cost at equal VERIFIED success is better; edit/verify failure rates and ' +
    'corrections measure reliability and autonomy._');
  return lines.join('\n');
}

/** Read .codeflare/metrics.jsonl, aggregate per model, open a markdown report. */
export async function showMetricsReport(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    vscode.window.showWarningMessage('CodeFlare: open a workspace folder to read its metrics.');
    return;
  }
  const file = vscode.Uri.joinPath(root, '.codeflare', 'metrics.jsonl');
  let text: string;
  try {
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
  } catch {
    vscode.window.showInformationMessage(
      'CodeFlare: no metrics recorded yet (.codeflare/metrics.jsonl does not exist). ' +
      'Metrics are written after each agent turn when codeflare.metrics is on.');
    return;
  }

  const byModel = new Map<string, Agg>();
  let total = 0;
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) { continue; }
    let rec: any;
    try { rec = JSON.parse(line); } catch { skipped++; continue; }
    const model = String(rec.model || 'unknown');
    const provider = String(rec.provider || 'unknown');
    const key = `${model}|${provider}`;
    const a = byModel.get(key) || emptyAgg(model, provider);
    a.turns++;
    total++;
    const outcome = String(rec.outcome || 'unknown');
    a.outcomes[outcome] = (a.outcomes[outcome] || 0) + 1;
    a.steps += rec.steps || 0;
    a.toolCalls += rec.toolCalls || 0;
    a.editAttempts += rec.editAttempts || 0;
    a.editFailures += rec.editFailures || 0;
    a.verifyRuns += rec.verifyRuns || 0;
    a.verifyFailures += rec.verifyFailures || 0;
    a.verifyRunsSkipped += rec.verifyRunsSkipped || 0;
    a.modelVerifyCommands += rec.modelVerifyCommands || 0;
    a.diagnosticErrors += rec.diagnosticErrors || 0;
    a.reviewFindings += rec.reviewFindings || 0;
    a.humanInterventions += rec.humanInterventions || 0;
    // Intervention breakdown (older lines have only the flat total → 'correction').
    const iv = rec.interventions || {};
    a.approvals += iv.approval || 0;
    a.clarifications += iv.clarification || 0;
    a.corrections += (iv.correction != null) ? iv.correction : (rec.humanInterventions || 0);
    // Verification verdict (older lines lack it → count as not-run).
    if (rec.verified === 'clean') { a.verifiedClean++; }
    else if (rec.verified === 'failed') { a.verifiedFailed++; }
    else { a.verifiedNotRun++; }
    a.subagentBatches += rec.subagentBatches || 0;
    a.subagentTasks += rec.subagentTasks || 0;
    a.subagentFileConflicts += rec.subagentFileConflicts || 0;
    a.subagentTokens += rec.subagentTokens || 0;
    a.subagentParallelMs += rec.subagentParallelMs || 0;
    a.subagentSequentialMs += rec.subagentSequentialMs || 0;
    a.promptTokens += rec.promptTokens || 0;
    a.completionTokens += rec.completionTokens || 0;
    a.filesChanged += rec.filesChanged || 0;
    a.durationMs += rec.durationMs || 0;
    byModel.set(key, a);
  }

  if (total === 0) {
    vscode.window.showInformationMessage('CodeFlare: metrics.jsonl exists but holds no readable turns.');
    return;
  }

  // Most-used model first, so the table's top row is the daily driver.
  const aggs = [...byModel.values()].sort((x, y) => y.turns - x.turns);
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: buildReport(aggs, total, skipped),
  });
  await vscode.window.showTextDocument(doc, { preview: false });
  log(`Metrics report: ${total} turn(s) across ${aggs.length} model(s)`);
}
