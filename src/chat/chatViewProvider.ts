import * as vscode from 'vscode';
import * as path from 'path';
import { VLLMClient, ChatMessage } from '../llm/client';
import { buildSystemPrompt, buildMessages, CodeAction, setProjectInstructions, setProjectMap, setProjectStacks, setProjectMemory, setGroundingNote, groundingConcerns, setReviewMode, looksLikeReviewRequest } from '../llm/prompts';
import { gatherContext, resolveActiveEditor } from '../editor/contextGatherer';
import { hasEditBlocks, parseEditBlocks, applyEditsWithDiff, getPreviewProvider } from '../editor/editApplier';
import { getToolDefinitions, executeTool, describeToolCall, copyableCommand, runVerifyCommand, resolveForRead } from '../llm/tools';
import { stripAllProbes, hasActiveProbes } from '../editor/probes';
import { isMcpTool, callMcpTool } from '../mcp/client';
import { collectNewErrors, snapshotErrorSignatures } from '../editor/diagnostics';
import { getRepoMap } from '../editor/repoMap';
import { setPreMutationRecorder } from '../editor/checkpoint';
import { getStacks, stacksPromptBlock, verifyStepsForChanges, invalidateStacks } from '../stacks/stacks';
import { loadProjectMemory } from '../utils/projectMemory';
import { loadExecutablesFromMemory } from '../utils/executables';
import { TurnMetrics, newTurnMetrics, flushTurnMetrics, isMutatingTool, isWriteFailure, isUserDecline, isVerifyLikeCommand } from '../utils/metrics';
import { analyzePng, looksBroken } from '../utils/pngStats';
import { extractPdfText } from '../utils/pdf';
import { getConfig, getDetectedModel, explicitModelSetting } from '../utils/config';
import { hasApiKey, setApiKey } from '../utils/secrets';
import { detectContextSize, detectModel, getContextSize } from '../utils/serverInfo';
import { log, getRecentLog } from '../utils/logger';
import { EvidenceItem, classifyToolEvidence, isBehavioral, makeEvidence, renderEvidenceLine, verificationSummary } from '../engine/evidence';
import { ExperimentRecord, GateOutcomes, decideAcceptance, newExperiment, stateForDecision } from '../engine/experiment';
import { TurnRunLog, appendExperiment } from '../engine/runlog';
import { beginPolicyTurn, endPolicyTurn, gateToolCall } from '../engine/policyGate';
import { policyMessage } from '../engine/policy';
import { VerificationConfig, compareMetrics, parseMetricValue, parseVerificationConfig, renderMetricComparisons } from '../engine/verificationConfig';
import { Isolation, acceptIsolation, beginIsolation, parkIsolation, rejectIsolation } from '../engine/gitIsolation';

/** Remove <think>…</think> reasoning blocks before storing assistant turns. */
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** Structured outcome of a delegated sub-agent run. */
interface SubagentResult {
  task: string;
  status: 'success' | 'partial' | 'failed';
  summary: string;
  changedFiles: string[];
  tests: string;
  openIssues: string[];
}

/** Parse a sub-agent's final text into a structured result (from its <<<RESULT>>> block). */
function parseSubagentResult(task: string, text: string): SubagentResult {
  const clean = stripThink(text);
  const block = /<<<RESULT>>>([\s\S]*?)(?:<<<END>>>|$)/i.exec(clean);
  const body = block ? block[1] : clean;
  const field = (name: string): string => {
    const m = new RegExp(`^\\s*${name}:\\s*(.*)$`, 'im').exec(body);
    return m ? m[1].trim() : '';
  };
  const nonNone = (s: string) => !!s && !/^none\.?$/i.test(s.trim());
  // Files are a comma/newline list; issues are prose (split on lines/semicolons
  // only, so a comma inside one issue doesn't fragment it).
  const listFiles = (s: string): string[] =>
    nonNone(s) ? s.split(/[,\n]/).map(x => x.trim()).filter(Boolean) : [];
  const listIssues = (s: string): string[] =>
    nonNone(s) ? s.split(/[\n;]+/).map(x => x.replace(/^[-*]\s*/, '').trim()).filter(Boolean) : [];

  const statusRaw = field('STATUS').toLowerCase();
  const status: SubagentResult['status'] =
    /success/.test(statusRaw) ? 'success' : /fail/.test(statusRaw) ? 'failed' : 'partial';
  const summary = field('SUMMARY') || clean.replace(/<<<RESULT>>>[\s\S]*$/i, '').trim().slice(0, 400) ||
    '(no summary — the sub-agent may not have finished)';
  return {
    task,
    // No result block at all → treat as partial (unverified) rather than success.
    status: block ? status : 'partial',
    summary,
    changedFiles: listFiles(field('CHANGED')),
    tests: field('TESTS'),
    openIssues: listIssues(field('OPEN')),
  };
}

/** Render a structured sub-agent result for the parent agent to read. */
function formatSubagentResult(r: SubagentResult, tag?: string): string {
  const icon = r.status === 'success' ? '✓' : r.status === 'failed' ? '✗' : '~';
  const lines = [`### ${icon} Subagent${tag ? ` ${tag}` : ''} [${r.status}]: ${r.task.slice(0, 100)}`, r.summary];
  if (r.changedFiles.length) { lines.push(`Changed: ${r.changedFiles.join(', ')}`); }
  if (r.tests && !/^none\.?$/i.test(r.tests)) { lines.push(`Tests: ${r.tests}`); }
  if (r.openIssues.length) { lines.push(`Open issues: ${r.openIssues.join('; ')}`); }
  if (r.status !== 'success') { lines.push('VERIFY this sub-agent\'s work and finish/redo anything incomplete yourself.'); }
  return lines.join('\n');
}

interface DiffLine { t: ' ' | '-' | '+' | '.'; line: string; }

/**
 * A compact line diff of old vs new file content: strip the common prefix/suffix,
 * show the changed middle (removed red, added green) with one line of context on
 * each side. Capped so a whole-file rewrite doesn't dump everything.
 */
function computeLineDiff(oldText: string, newText: string, cap = 40): DiffLine[] {
  if (oldText === newText) { return []; }
  const b = newText.split('\n');
  if (!oldText) {
    const out: DiffLine[] = b.slice(0, cap).map(line => ({ t: '+' as const, line }));
    if (b.length > cap) { out.push({ t: '.', line: `… ${b.length - cap} more added` }); }
    return out;
  }
  const a = oldText.split('\n');

  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) { p++; }
  let sa = a.length - 1, sb = b.length - 1;
  while (sa >= p && sb >= p && a[sa] === b[sb]) { sa--; sb--; }

  const removed = a.slice(p, sa + 1);
  const added = b.slice(p, sb + 1);
  const out: DiffLine[] = [];
  if (p > 0) { out.push({ t: ' ', line: a[p - 1] }); }
  removed.slice(0, cap).forEach(line => out.push({ t: '-', line }));
  if (removed.length > cap) { out.push({ t: '.', line: `… ${removed.length - cap} more removed` }); }
  added.slice(0, cap).forEach(line => out.push({ t: '+', line }));
  if (added.length > cap) { out.push({ t: '.', line: `… ${added.length - cap} more added` }); }
  if (sa + 1 < a.length) { out.push({ t: ' ', line: a[sa + 1] }); }
  return out;
}

/** The workspace path a write tool touched, for post-edit diagnostics. */
function writtenPathOf(name: string, rawArgs: string): string | undefined {
  let args: any = {};
  try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return undefined; }
  if (name === 'create_file' || name === 'edit_file') { return args.path; }
  if (name === 'move_file') { return args.destination; }
  return undefined;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

function imageMime(p: string): string {
  const ext = p.toLowerCase().split('.').pop();
  switch (ext) {
    case 'svg': return 'image/svg+xml';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'bmp': return 'image/bmp';
    default: return 'image/png';
  }
}

/** Extract workspace-relative image filenames mentioned in text. */
function imagePathsInText(text: string): string[] {
  const matches = text.match(/[\w./\\-]+\.(?:png|jpe?g|gif|webp|svg|bmp)/gi) || [];
  return [...new Set(matches)];
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

interface TranscriptEntry {
  role: 'user' | 'assistant';
  text?: string;
  // User-attached images are plain data-url strings; agent-generated previews
  // carry their workspace-relative path as name (shown on hover / in the log).
  images?: (string | { url: string; name: string })[];
  files?: string[];
}

interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  subtasks?: Todo[];
}

function normalizeTodos(list: any): Todo[] {
  return (Array.isArray(list) ? list : [])
    .filter((t: any) => t && typeof t.content === 'string')
    .map((t: any) => {
      const todo: Todo = {
        content: t.content,
        status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending',
      };
      if (Array.isArray(t.subtasks) && t.subtasks.length) {
        todo.subtasks = normalizeTodos(t.subtasks);
      }
      return todo;
    });
}

/** Count leaf steps and how many are completed (for the header ratio). */
function countLeaves(todos: Todo[]): { total: number; done: number } {
  let total = 0, done = 0;
  for (const t of todos) {
    if (t.subtasks && t.subtasks.length) {
      const c = countLeaves(t.subtasks);
      total += c.total; done += c.done;
    } else {
      total++;
      if (t.status === 'completed') { done++; }
    }
  }
  return { total, done };
}

function todosIncomplete(todos: Todo[]): boolean {
  return todos.some(t =>
    (t.subtasks && t.subtasks.length) ? todosIncomplete(t.subtasks) : t.status !== 'completed'
  );
}

export class ChatViewProvider {
  private _panel?: vscode.WebviewPanel;
  private _client: VLLMClient;
  private _history: ChatMessage[] = [];
  // What the user sees, kept separately from the model-facing _history so a
  // reopened panel can render the conversation cleanly.
  private _transcript: TranscriptEntry[] = [];
  private _todos: Todo[] = [];
  // One agent turn at a time; Stop must end the whole loop, not just one request.
  private _busy = false;
  private _stopRequested = false;
  // Live subagent clients (run on their own VLLMClient), so Stop can abort their
  // in-flight requests too — the main _client.abort() doesn't reach them.
  private _subagentClients: Set<VLLMClient> = new Set();
  // Bumped whenever the conversation is cleared. A turn captures it at start and
  // drops its pending history writes if it changed — so a mid-turn Clear can't be
  // repopulated with the finishing turn's orphaned tool messages.
  private _historyEpoch = 0;
  // Set when a fresh plan was just created — the turn pauses for user review.
  private _planAwaitingReview = false;
  // Turn context for new-plan detection (stale persisted todos must not mask it).
  private _currentRound = 0;
  private _planCallsThisTurn = 0;
  // True while executing an approval turn ("Plan approved — …"): a re-plan the
  // model makes right after approval must EXECUTE, not pause for review again.
  private _approvalTurn = false;
  // Images already flagged by QC this turn chain (rel → stats signature) — an
  // unchanged image is flagged ONCE, not re-litigated every follow-up round.
  private _qcReported = new Map<string, string>();
  private _queue: Array<{ text: string; images?: string[]; files?: { name: string; content: string }[] }> = [];
  // Per-turn checkpoint: first write to each file records its pre-state
  // (null = didn't exist) so the whole turn can be reverted. In-memory only —
  // reverts are offered for this session; a reload clears them.
  private _activeCheckpoint?: { id: string; time: number; files: Map<string, string | null> };
  private _checkpoints: Array<{ id: string; time: number; files: Array<{ path: string; oldContent: string | null }> }> = [];
  // Error signatures present in the workspace at the START of the current turn.
  // The verify step reports only errors NEW relative to this (regressions),
  // never pre-existing ones that are out of scope.
  private _errorBaseline: Set<string> = new Set();
  // Per-turn metrics (recorded to .codeflare/metrics.jsonl) + the unique files
  // mutated this turn. Undefined when metrics are disabled.
  private _turnMetrics?: TurnMetrics;
  private _turnChangedFiles: Set<string> = new Set();
  // Every file mutated this turn by ANY tool (create/edit/move/delete/apply_patch/
  // rename) — fed by the checkpoint recorder, so verification covers changes made
  // through mechanisms the loop doesn't sniff by tool name.
  private _turnMutatedPaths: Set<string> = new Set();
  // The user's original request text for this turn — the diff review judges the
  // change against it (recursive fix rounds carry automated feedback, not this).
  private _turnRequest = '';
  // Verify steps already run green this turn, keyed by command + a signature of
  // the changed files in that module, so an unchanged module isn't re-verified
  // across fix rounds. Cleared at the start of each turn (round 0).
  private _verifiedSteps: Map<string, string> = new Map();
  // Typed evidence for this turn (commands + outcome, verify_visual verdicts,
  // probes, diagnostics) — what the requirement review maps each requirement
  // to and what the acceptance decision weighs. Reset at round 0, accumulates
  // across fix rounds.
  private _turnEvidence: EvidenceItem[] = [];
  // Per-gate outcomes for this turn, feeding the acceptance decision.
  private _turnGates: GateOutcomes = {};
  // Chronological run record + experiment record for this turn (round 0 only).
  private _runLog: TurnRunLog | undefined;
  private _experiment: ExperimentRecord | undefined;
  // The last finished experiment — what Prove It / Break My Solution target.
  private _lastExperiment: ExperimentRecord | undefined;
  // Verification-only turn (Prove It / Break My Solution): write tools, probes
  // and subagents are withheld at the runtime level for this turn.
  private _verifyOnlyTurn = false;
  // Project verification adapter (.codeflare/verification.json), reloaded per
  // turn; a malformed file is surfaced, never silently treated as absent.
  private _verificationConfig: VerificationConfig | undefined;
  // Metric baseline for this turn, captured just before the FIRST mutation so
  // the candidate run after the gates has something honest to compare against.
  private _metricBaseline: Record<string, number | undefined> | undefined;
  private _metricBaselinePromise: Promise<void> | undefined;
  // Git experiment isolation for this turn (autonomous profiles only).
  private _isolation: Isolation | undefined;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _version: string = '',
    private readonly _state?: vscode.Memento
  ) {
    this._client = new VLLMClient();
    if (this._state) {
      this._history = this._state.get<ChatMessage[]>('history', []);
      this._transcript = this._state.get<TranscriptEntry[]>('transcript', []);
      this._todos = this._state.get<Todo[]>('todos', []);
    }
  }

  /** Persist conversation state (bounded) so it survives reloads. */
  private _persist(): void {
    if (!this._state) { return; }
    this._state.update('history', this._history.slice(-120));
    this._state.update('transcript', this._transcript.slice(-100));
    this._state.update('todos', this._todos);
  }

  /** Read a workspace-relative file's text, or '' if missing. */
  private async _readWorkspaceFile(relPath: string): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) { return ''; }
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, relPath.replace(/\\/g, '/')));
      return new TextDecoder().decode(bytes);
    } catch {
      return '';
    }
  }

  // ── Checkpoints (revert a whole turn) ─────────────────────────────

  // Binary formats would corrupt through a text decode/encode roundtrip — the
  // checkpoint skips them (they're rarely agent-written via create/edit anyway).
  private static readonly BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|vsix|woff2?|ttf|eot|mp[34]|wav|ogg)$/i;

  /** Record a file's pre-state into the active checkpoint (first touch only). */
  private async _captureCheckpoint(relPath: string | undefined): Promise<void> {
    if (!relPath || !this._activeCheckpoint) { return; }
    const key = relPath.replace(/\\/g, '/');
    if (this._activeCheckpoint.files.has(key)) { return; }
    if (ChatViewProvider.BINARY_EXT.test(key)) { return; }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) { return; }
    try {
      const uri = vscode.Uri.joinPath(root, key);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File || stat.size > 2 * 1024 * 1024) { return; }
      const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      this._activeCheckpoint.files.set(key, content);
    } catch {
      this._activeCheckpoint.files.set(key, null); // didn't exist before this turn
    }
  }

  /** Close the turn's checkpoint; if it captured writes, offer a revert button. */
  private _finishCheckpoint(): void {
    const cp = this._activeCheckpoint;
    this._activeCheckpoint = undefined;
    setPreMutationRecorder(undefined);
    if (!cp || cp.files.size === 0) { return; }
    const record = {
      id: cp.id,
      time: cp.time,
      files: [...cp.files].map(([p, c]) => ({ path: p, oldContent: c })),
    };
    this._checkpoints.push(record);
    if (this._checkpoints.length > 15) { this._checkpoints.shift(); }
    // Persist so a revert still works after a window reload (best-effort).
    void this._persistCheckpoint(record);
    this._postMessage({ type: 'checkpoint', id: cp.id, count: cp.files.size });
    log(`Checkpoint ${cp.id}: ${cp.files.size} file(s) captured`);
  }

  /** Write one checkpoint to .codeflare/checkpoints/ and prune to the newest 15. */
  private async _persistCheckpoint(record: { id: string; time: number; files: Array<{ path: string; oldContent: string | null }> }): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) { return; }
    try {
      const dir = vscode.Uri.joinPath(root, '.codeflare', 'checkpoints');
      await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(dir, `${record.id}.json`),
        new TextEncoder().encode(JSON.stringify(record)));
      const entries = (await vscode.workspace.fs.readDirectory(dir))
        .filter(([n, k]) => k === vscode.FileType.File && n.endsWith('.json'))
        .sort(([a], [b]) => a.localeCompare(b));   // ids are Date.now() → lexicographic = chronological
      for (const [name] of entries.slice(0, Math.max(0, entries.length - 15))) {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, name));
      }
    } catch (err: any) {
      log(`Checkpoint persist failed: ${err.message}`);
    }
  }

  /** Load a persisted checkpoint from disk (survives window reloads). */
  private async _loadPersistedCheckpoint(id: string): Promise<{ id: string; time: number; files: Array<{ path: string; oldContent: string | null }> } | undefined> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root || !/^\d+$/.test(id)) { return undefined; }
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(root, '.codeflare', 'checkpoints', `${id}.json`));
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (parsed && parsed.id === id && Array.isArray(parsed.files)) { return parsed; }
    } catch { /* not on disk either */ }
    return undefined;
  }

  /** Restore every file in the checkpoint to its pre-turn state. */
  private async _revertCheckpoint(id: string): Promise<void> {
    const cp = this._checkpoints.find(c => c.id === id) || await this._loadPersistedCheckpoint(id);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!cp || !root) {
      this._postMessage({ type: 'notice', text: 'Checkpoint no longer available.', level: 'error' });
      return;
    }
    let restored = 0;
    let trashed = 0;
    const trashDir = vscode.Uri.joinPath(root, '.codeflare-trash', `reverted-${id}`);
    for (const f of cp.files) {
      const uri = vscode.Uri.joinPath(root, f.path);
      try {
        if (f.oldContent === null) {
          // Created this turn — move it to the trash rather than hard-delete.
          await vscode.workspace.fs.createDirectory(trashDir);
          await vscode.workspace.fs.rename(
            uri, vscode.Uri.joinPath(trashDir, f.path.replace(/[\\/]/g, '_')), { overwrite: true });
          trashed++;
        } else {
          await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(f.oldContent));
          restored++;
        }
      } catch (err: any) {
        log(`Revert failed for ${f.path}: ${err.message}`);
      }
    }
    this._checkpoints = this._checkpoints.filter(c => c.id !== id);
    try {
      await vscode.workspace.fs.delete(
        vscode.Uri.joinPath(root, '.codeflare', 'checkpoints', `${id}.json`));
    } catch { /* was memory-only */ }
    // Tell the model too — it must not act on its now-stale beliefs about
    // these files' contents.
    this._history.push({
      role: 'user',
      content: `NOTE: I reverted ALL file changes from your previous turn (${restored + trashed} file(s) ` +
        `restored to their earlier state). Re-read any of those files before editing them again.`,
    });
    this._persist();
    this._postMessage({ type: 'checkpointReverted', id });
    this._postMessage({
      type: 'toolActivity',
      label: `↺ turn reverted: ${restored} file(s) restored${trashed ? `, ${trashed} moved to trash` : ''}`,
    });
    log(`Checkpoint ${id} reverted: ${restored} restored, ${trashed} trashed`);
  }

  /** Handle the update_todos tool: refresh the plan state + UI. Returns the tool result. */
  private _handleUpdateTodos(rawArgs: string): string {
    let args: any = {};
    try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return 'Invalid todos JSON.'; }
    const incoming = normalizeTodos(args.todos);

    // A FRESH plan pauses for user review — like Claude's plan mode. "Fresh"
    // means: the first update_todos of a user-initiated turn (round 0), with
    // ≥2 steps and nothing done. Deliberately NOT based on whether old todos
    // exist — stale persisted todos from a previous run must not mask a new
    // plan. A resend of the identical plan (models love doing that right after
    // approval) does not re-pause.
    this._planCallsThisTurn++;
    const leafTexts = (todos: Todo[]): string => {
      const acc: string[] = [];
      const walk = (arr: Todo[]) => {
        for (const t of arr) {
          if (t.subtasks && t.subtasks.length) { walk(t.subtasks); }
          else { acc.push(t.content.trim().toLowerCase()); }
        }
      };
      walk(todos);
      return acc.sort().join('\n');
    };
    const inCounts = countLeaves(incoming);
    const isNewPlan =
      this._currentRound === 0 &&
      !this._approvalTurn &&
      this._planCallsThisTurn === 1 &&
      inCounts.total >= 2 &&
      inCounts.done === 0 &&
      leafTexts(incoming) !== leafTexts(this._todos);

    // Completed is sticky: the model often resends a stale tree and would
    // visibly UN-check items we already advanced. Same-content items that were
    // completed stay completed.
    const doneSet = new Set<string>();
    const collectDone = (arr: Todo[]) => {
      for (const t of arr) {
        if (t.status === 'completed') { doneSet.add(t.content.trim().toLowerCase()); }
        if (t.subtasks) { collectDone(t.subtasks); }
      }
    };
    collectDone(this._todos);
    const applyDone = (arr: Todo[]) => {
      for (const t of arr) {
        if (doneSet.has(t.content.trim().toLowerCase())) { t.status = 'completed'; }
        if (t.subtasks) { applyDone(t.subtasks); }
      }
    };
    applyDone(incoming);

    this._todos = incoming;
    this._rollupTodos(this._todos);
    this._postMessage({ type: 'todos', todos: this._todos });
    this._persist();
    const { total, done } = countLeaves(this._todos);

    if (isNewPlan && getConfig().planApproval) {
      this._planAwaitingReview = true;
      return `Plan recorded (${total} steps) and shown to the user. STOP NOW — the user will ` +
        `review the plan first. Do not execute anything until they approve or give feedback.`;
    }
    return `Plan updated: ${done}/${total} step(s) completed.`;
  }

  /** Set parent status from children (completed if all done, else in_progress if any active). */
  private _rollupTodos(todos: Todo[]): void {
    for (const t of todos) {
      if (t.subtasks && t.subtasks.length) {
        this._rollupTodos(t.subtasks);
        if (t.subtasks.every(s => s.status === 'completed')) { t.status = 'completed'; }
        else if (t.subtasks.some(s => s.status !== 'pending')) { t.status = 'in_progress'; }
      }
    }
  }

  /**
   * Keep the plan in sync with real work: when the agent writes a file, mark the
   * matching todo completed and advance the next one — local models often forget
   * to call update_todos after the initial plan.
   */
  private _advanceTodosForWrite(relPath: string): void {
    if (this._todos.length === 0) { return; }
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const norm = relPath.replace(/\\/g, '/');

    // Plans usually name files with PARTIAL paths ("Create css/style.css")
    // while the write lands at "omega-race-vector/css/style.css" — so try
    // progressively shorter suffixes of the written path, longest first:
    // full path → css/style.css → style.css. Word-boundary anchored so
    // "main.js" never ticks a "domain.js" step, and a suffix never matches
    // inside a LONGER (different) path in the todo text.
    const segs = norm.split('/').filter(Boolean);
    const suffixes = segs.map((_, i) => segs.slice(i).join('/'));

    const leaves: Todo[] = [];
    const collect = (arr: Todo[]) => {
      for (const t of arr) { if (t.subtasks && t.subtasks.length) { collect(t.subtasks); } else { leaves.push(t); } }
    };
    collect(this._todos);

    let match: Todo | undefined;
    for (const suffix of suffixes) {
      const re = new RegExp(`(^|[^\\w/-])${esc(suffix)}(?![\\w-])`, 'i');
      match = leaves.find(t => t.status !== 'completed' && re.test(t.content));
      if (match) { break; }
    }
    if (!match) { return; }

    match.status = 'completed';
    if (!leaves.some(t => t.status === 'in_progress')) {
      const next = leaves.find(t => t.status === 'pending');
      if (next) { next.status = 'in_progress'; }
    }
    this._rollupTodos(this._todos);
    this._postMessage({ type: 'todos', todos: this._todos });
    this._persist();
  }

  /**
   * Run one self-contained sub-task in a nested, headless agent loop with its
   * own client (so several can run in parallel without clobbering each other's
   * request state) and its own scratch context. Returns a STRUCTURED result.
   */
  private async _runOneSubagent(task: string, client: VLLMClient, tag: string): Promise<SubagentResult> {
    const config = getConfig();
    const system =
      'You are a focused sub-agent inside CodeFlare. Complete the given task using your tools. ' +
      'Do not ask questions — make reasonable assumptions. Keep going until the task is done or ' +
      'you are genuinely blocked. When finished, reply with a short summary FOLLOWED BY exactly ' +
      'this block (fill it in; use "none" where empty):\n' +
      '<<<RESULT>>>\n' +
      'STATUS: success | partial | failed\n' +
      'SUMMARY: <one or two sentences on what you did>\n' +
      'CHANGED: <comma-separated files you created/edited, or none>\n' +
      'TESTS: <how you verified it (command + outcome), or none>\n' +
      'OPEN: <remaining issues or follow-ups, or none>\n' +
      '<<<END>>>';
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: task },
    ];
    // Same tools, minus delegation/planning/debug to avoid recursion and shared state.
    const tools = getToolDefinitions({
      write: config.agentEdit,
      run: config.agentRunCommands,
      web: config.webAccess,
      subagent: false,
      plan: false,
      probes: config.agentProbes,
    });

    let finalText = '';
    let emptyNudges = 0;
    const taskStarted = Date.now();
    // Register so Stop can abort this subagent's in-flight request too.
    this._subagentClients.add(client);
    try {
    for (let step = 0; step < config.agentMaxSteps; step++) {
      if (this._stopRequested) { break; }
      let hadError = false;
      const result = await client.streamChat(messages, {
        onToken: () => { /* headless */ },
        onThinking: () => { /* headless */ },
        onDone: () => { /* per-step */ },
        onError: (e) => { hadError = true; finalText = `Sub-agent error: ${e}`; },
      }, tools);
      // Measure token cost of subagents so their overhead is visible in metrics.
      if (this._turnMetrics && result.stats) { this._turnMetrics.subagentTokens += result.stats.completionTokens || 0; }
      if (hadError) { break; }
      // Stop pressed while this request was streaming: don't execute its tool calls.
      if (this._stopRequested) { break; }

      if (result.toolCalls.length === 0) {
        finalText = stripThink(result.content).trim() || finalText;
        if (!finalText && emptyNudges < 1 && step < config.agentMaxSteps - 1) {
          emptyNudges++;
          messages.push({ role: 'assistant', content: '(no reply)' });
          messages.push({
            role: 'user',
            content: 'Your reply was EMPTY. If the task is not finished, continue with tool calls ' +
              'until it is. When it IS finished, reply with your summary and the <<<RESULT>>> block.',
          });
          continue;
        }
        break;
      }

      messages.push({ role: 'assistant', content: stripThink(result.content), tool_calls: result.toolCalls });
      for (const call of result.toolCalls) {
        if (this._stopRequested) { break; }
        this._postMessage({
          type: 'toolActivity',
          label: `↳${tag} ${describeToolCall(call.function.name, call.function.arguments)}`,
          copy: copyableCommand(call.function.name, call.function.arguments),
        });
        const out = isMcpTool(call.function.name)
          ? await callMcpTool(call.function.name, call.function.arguments)
          : await executeTool(call.function.name, call.function.arguments);
        messages.push({ role: 'tool', tool_call_id: call.id, content: out });
      }
    }
    } finally {
      this._subagentClients.delete(client);
      if (this._turnMetrics) {
        this._turnMetrics.subagentTasks++;
        this._turnMetrics.subagentSequentialMs += Date.now() - taskStarted;
      }
    }

    log(`Subagent${tag} finished (${finalText.length} chars)`);
    return parseSubagentResult(task, finalText);
  }

  /** run_subagent(task): one delegated sub-task, structured result. */
  private async _runSubagent(rawArgs: string): Promise<string> {
    let task = '';
    try { task = (JSON.parse(rawArgs || '{}').task || '').trim(); } catch { /* ignore */ }
    if (!task) { return 'No task provided to run_subagent.'; }
    const r = await this._runOneSubagent(task, new VLLMClient(), '');
    return formatSubagentResult(r);
  }

  /** run_subagents(tasks[]): several INDEPENDENT sub-tasks in parallel, structured results. */
  private async _runSubagents(rawArgs: string): Promise<string> {
    let tasks: string[] = [];
    try {
      const arr = JSON.parse(rawArgs || '{}').tasks;
      if (Array.isArray(arr)) { tasks = arr.map((t: any) => String(t || '').trim()).filter(Boolean); }
    } catch { /* ignore */ }
    if (tasks.length === 0) { return 'No tasks provided to run_subagents (expects a "tasks" array).'; }

    const MAX_PARALLEL = 4;
    if (tasks.length > MAX_PARALLEL) {
      return `Too many parallel tasks (${tasks.length}); cap is ${MAX_PARALLEL}. ` +
        `Split into smaller batches, or run some sequentially with run_subagent.`;
    }

    this._postMessage({ type: 'toolActivity', label: `running ${tasks.length} subagents in parallel…` });
    // Each subagent gets its OWN client so concurrent requests don't share the
    // single abort controller / request state.
    const batchStarted = Date.now();
    const results = await Promise.all(
      tasks.map((task, i) => this._runOneSubagent(task, new VLLMClient(), `[${String.fromCharCode(65 + i)}]`)
        .catch((e): SubagentResult => ({
          task, status: 'failed', summary: `Crashed: ${e?.message || e}`, changedFiles: [], tests: '', openIssues: [],
        })))
    );

    // Telemetry (measure, don't tune): batch wall-clock and whether tasks
    // collided on the same file — the two things that decide if parallel is
    // worth it and safe. subagentSequentialMs (summed per task) vs this batch's
    // wall-clock gives the real speedup; a conflict count > 0 means the "only
    // independent tasks" contract was violated.
    if (this._turnMetrics) {
      const m = this._turnMetrics;
      m.subagentBatches++;
      m.subagentParallelMs += Date.now() - batchStarted;
      const seen = new Set<string>();
      const conflicts = new Set<string>();
      for (const r of results) {
        for (const f of r.changedFiles) {
          const key = f.replace(/\\/g, '/').trim();
          if (!key) { continue; }
          if (seen.has(key)) { conflicts.add(key); } else { seen.add(key); }
        }
      }
      m.subagentFileConflicts += conflicts.size;
      if (conflicts.size > 0) {
        log(`Subagents: ${conflicts.size} file(s) touched by more than one parallel task: ${[...conflicts].join(', ')}`);
      }
    }

    const counts = { success: 0, partial: 0, failed: 0 };
    for (const r of results) { counts[r.status]++; }
    const header = `Ran ${results.length} subagents in parallel — ` +
      `${counts.success} success, ${counts.partial} partial, ${counts.failed} failed. ` +
      `Review each and integrate/redo as needed:`;
    return `${header}\n\n${results.map((r, i) => formatSubagentResult(r, String.fromCharCode(65 + i))).join('\n\n')}`;
  }

  /**
   * verify_visual(path, expectation): send a produced screenshot to the (vision-
   * capable) model and ask whether it matches the intended result. Returns the
   * verdict as the tool result, so the agent can fix and re-check in its loop.
   */
  private async _verifyVisual(rawArgs: string): Promise<string> {
    let path = '', expectation = '';
    try {
      const a = JSON.parse(rawArgs || '{}');
      path = String(a.path || '').trim();
      expectation = String(a.expectation || '').trim();
    } catch { /* ignore */ }
    if (!path) { return 'verify_visual needs a "path" to the image.'; }
    if (!expectation) { return 'verify_visual needs an "expectation" describing what the image should show.'; }
    if (!IMAGE_EXT.test(path)) { return `"${path}" is not an image file (png/jpg/gif/webp/…).`; }

    const uri = resolveForRead(path.replace(/\\/g, '/'));
    if ('error' in uri) { return uri.error; }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (e: any) {
      return `Cannot read image "${path}": ${e.message}. Produce the screenshot first, then verify it.`;
    }
    if (bytes.length > 6 * 1024 * 1024) {
      return `Image "${path}" is too large to verify (${Math.round(bytes.length / 1024 / 1024)}MB).`;
    }

    const dataUrl = `data:${imageMime(path)};base64,${Buffer.from(bytes).toString('base64')}`;
    this._postMessage({ type: 'toolActivity', label: `verify_visual: checking ${path}…` });

    const system =
      'You verify whether a screenshot matches an intended result. Look at the image and judge ' +
      'STRICTLY whether it shows what is described. Reply in EXACTLY this format:\n' +
      'VERDICT: OK\n(if it clearly matches)\nor\nVERDICT: MISMATCH\n' +
      '- <concrete visual difference>\n- <another>\n' +
      'Describe only what you actually SEE. A blank, black or empty image is a MISMATCH.';
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Intended result:\n${expectation}` },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ];

    let verdict = '';
    try {
      verdict = (await this._client.complete(messages, 1024)).trim();
    } catch (e: any) {
      return `Visual check failed: ${e.message}. Your endpoint may not accept images (needs a vision-capable model).`;
    }
    if (!verdict) {
      return `No verdict returned for ${path} — the model may not be vision-capable, or spent its ` +
        `budget reasoning. Treat the image as UNVERIFIED.`;
    }
    log(`verify_visual(${path}): ${verdict.split('\n')[0]}`);
    return `verify_visual(${path}) — intended: ${expectation.slice(0, 120)}\n${verdict}`;
  }

  /**
   * Toggle the chat panel on the right side of the editor.
   * If open → close it. If closed → open it in ViewColumn.Two (right).
   */
  togglePanel(): void {
    if (this._panel) {
      this._panel.dispose();
      return;
    }

    this._panel = vscode.window.createWebviewPanel(
      'codeflare.chatPanel',
      'CodeFlare Chat',
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
      }
    );

    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
    this._setupWebviewMessageHandler(this._panel.webview);

    this._panel.onDidDispose(() => {
      this._panel = undefined;
    });
  }

  /**
   * Ensure the panel is open (for commands that need to send to it).
   */
  ensurePanel(): void {
    if (!this._panel) {
      this.togglePanel();
    }
  }

  /** Update the webview's connection indicator (fed by the periodic health check). */
  updateHealth(healthy: boolean): void {
    this._postMessage({ type: 'statusUpdate', healthy });
  }

  private _setupWebviewMessageHandler(webview: vscode.Webview): void {
    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'sendMessage':
          await this._handleUserMessage(msg.text, msg.images, msg.files);
          break;
        case 'stopGeneration':
          // Stop the whole agent loop: flag first (checked between steps), then
          // abort the in-flight request — including any running subagents, whose
          // clients the main _client.abort() doesn't reach. Drop queued messages.
          this._stopRequested = true;
          this._queue.length = 0;
          this._client.abort();
          for (const c of this._subagentClients) { c.abort(); }
          break;
        case 'clearChat':
          // Bump the epoch so a turn finishing after this Clear discards its
          // pending history/compaction writes instead of repopulating the
          // cleared conversation with orphaned assistant/tool messages.
          this._historyEpoch++;
          this._history = [];
          this._transcript = [];
          this._todos = [];
          this._persist();
          this._postMessage({ type: 'chatCleared' });
          break;
        case 'requestHistory':
          this._postMessage({ type: 'restoreTranscript', transcript: this._transcript });
          if (this._todos.length > 0) {
            this._postMessage({ type: 'todos', todos: this._todos });
          }
          break;
        case 'applyEdit':
          await this._handleApplyEdit(msg.searchReplace);
          break;
        case 'insertCode':
          await this._handleInsertCode(msg.code);
          break;
        case 'replaceCode':
          await this._handleReplaceCode(msg.code);
          break;
        case 'copyCode':
          await vscode.env.clipboard.writeText(msg.code);
          break;
        case 'copyLog': {
          const parts = [
            '===== CODEFLARE CHAT LOG =====',
            msg.chat || '(empty chat)',
            '',
            '===== EXTENSION LOG (recent) =====',
            ...getRecentLog(),
          ];
          await vscode.env.clipboard.writeText(parts.join('\n'));
          this._postMessage({ type: 'notice', text: 'Log copied to clipboard', level: 'success' });
          break;
        }
        case 'runCommand':
          await this._handleRunCommand(msg.command);
          break;
        case 'extractPdf':
          await this._handleExtractPdf(msg.name, msg.dataBase64);
          break;
        case 'getConfig':
          this._sendConfigState();
          break;
        case 'saveConfig':
          await this._handleSaveConfig(msg.config);
          break;
        case 'revertCheckpoint':
          await this._revertCheckpoint(msg.id);
          break;
        case 'listWorkspaceFiles': {
          // File list for the @mention picker (bounded; heavy dirs excluded).
          const found = await vscode.workspace.findFiles(
            '**/*',
            '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.codeflare-trash/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/coverage/**}',
            2000
          );
          const root = vscode.workspace.workspaceFolders?.[0]?.uri;
          const rels = root
            ? found.map(f => path.relative(root.fsPath, f.fsPath).replace(/\\/g, '/')).sort()
            : [];
          this._postMessage({ type: 'workspaceFiles', files: rels });
          break;
        }
        case 'exportChat':
          await this._handleExportChat(msg.markdown);
          break;
      }
    });
  }

  /** Save the serialized chat (with embedded images) as a markdown file. */
  private async _handleExportChat(markdown: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const target = await vscode.window.showSaveDialog({
      defaultUri: root ? vscode.Uri.joinPath(root, `codeflare-chat-${stamp}.md`) : undefined,
      filters: { Markdown: ['md'] },
    });
    if (!target) { return; }
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(markdown));
    this._postMessage({ type: 'notice', text: `Chat exported: ${path.basename(target.fsPath)}`, level: 'success' });
    log(`Chat exported to ${target.fsPath} (${markdown.length} chars)`);
    // Preview renders the embedded data-URI screenshots; the raw file (with
    // MB-long base64 lines) stays closed.
    try { await vscode.commands.executeCommand('markdown.showPreview', target); } catch { /* optional */ }
  }

  private _historyChars(): number {
    // Images count as a small nominal, not their base64 length — otherwise one
    // pasted screenshot would trigger compaction immediately.
    return this._history.reduce((n, m) => {
      const c = typeof m.content === 'string'
        ? m.content.length
        : (m.content || []).reduce((s: number, p: any) =>
            s + (p.type === 'text' ? (p.text || '').length : 100), 0);
      return n + c;
    }, 0);
  }

  /**
   * Auto-compact: when the conversation grows past the threshold, summarize the
   * older turns into a single note and keep the most recent turns verbatim.
   * The kept window starts at a user boundary so tool pairing stays valid.
   */
  private async _maybeCompactContext(): Promise<void> {
    const config = getConfig();
    if (!config.contextAutoCompact) { return; }
    if (this._historyChars() < config.contextCompactThreshold) { return; }

    // Choose a split point: keep the last N messages, snapped to a user turn.
    let split = Math.max(0, this._history.length - config.contextKeepRecent);
    while (split < this._history.length && this._history[split].role !== 'user') { split++; }
    if (split >= this._history.length) { return; } // no clean boundary — skip

    const older = this._history.slice(0, split);
    const recent = this._history.slice(split);
    if (older.length === 0) { return; }

    this._postMessage({ type: 'toolActivity', label: 'compacting conversation…' });
    const epoch = this._historyEpoch;
    try {
      const summary = await this._summarize(older);
      if (!summary) { return; }
      // The chat was cleared while we were summarizing — don't resurrect the
      // old history by assigning the summary window over the cleared thread.
      if (this._historyEpoch !== epoch) { return; }
      this._history = [
        { role: 'user', content: `[CONVERSATION SUMMARY — earlier turns condensed to save context]\n\n${summary}` },
        ...recent,
      ];
      this._persist();
      this._postMessage({ type: 'toolActivity', label: `context compacted (${older.length} earlier msgs → summary)` });
      log(`Context compacted: ${older.length} old msgs summarized, ${recent.length} kept`);
    } catch (err: any) {
      // On failure keep the full history; the send-time window still bounds it.
      log(`Compaction failed: ${err.message}`);
    }
  }

  private async _summarize(messages: ChatMessage[]): Promise<string> {
    const serialized = messages.map(m => {
      const c = typeof m.content === 'string'
        ? m.content
        : (m.content || []).map((p: any) => (p.type === 'text' ? p.text : '[image]')).join(' ');
      if (m.role === 'assistant' && m.tool_calls) {
        return `assistant: ${c}\n[called: ${m.tool_calls.map(t => describeToolCall(t.function.name, t.function.arguments)).join('; ')}]`;
      }
      if (m.role === 'tool') {
        return `tool result: ${String(c).slice(0, 1200)}`;
      }
      return `${m.role}: ${c}`;
    }).join('\n\n');

    const sys =
      'You compact a coding-assistant conversation. Summarize the earlier turns so the ' +
      'assistant can continue seamlessly. PRESERVE: the user\'s goals and explicit requests, ' +
      'decisions and constraints, files created/edited and their purpose and current state, ' +
      'key facts learned, and any unfinished tasks. Use compact bullet points. Do not invent details.';

    const summaryMessages: ChatMessage[] = [
      { role: 'system', content: sys },
      { role: 'user', content: `Summarize this conversation so far:\n\n${serialized}` },
    ];
    return this._client.complete(summaryMessages, 1200);
  }

  /** Extract text from a pasted/attached PDF and hand it back as a text attachment. */
  private async _handleExtractPdf(name: string, dataBase64: string): Promise<void> {
    try {
      const bytes = new Uint8Array(Buffer.from(dataBase64, 'base64'));
      const { text, pages, truncated } = await extractPdfText(bytes, this._extensionUri.fsPath);
      if (!text.trim()) {
        this._postMessage({ type: 'pdfExtracted', name, error: 'no extractable text (scanned/image PDF?)' });
        return;
      }
      this._postMessage({ type: 'pdfExtracted', name, content: text, pages, truncated });
      log(`Extracted PDF ${name}: ${pages} page(s), ${text.length} chars${truncated ? ' (truncated)' : ''}`);
    } catch (err: any) {
      this._postMessage({ type: 'pdfExtracted', name, error: err.message });
      log(`PDF extract failed for ${name}: ${err.message}`);
    }
  }

  /** Send the current (non-secret) config to the webview config panel. */
  private _sendConfigState(): void {
    const config = getConfig();
    // The panel's model field shows the user's explicit setting (blank = auto),
    // while the discovered model is offered separately as a placeholder — so
    // "auto" stays auto instead of being silently frozen into an explicit value.
    // A stored value equal to the local built-in default is normalized to blank
    // (older builds saved that default, which shadowed discovery).
    const storedModel = (vscode.workspace.getConfiguration('codeflare').get<string>('model', '') || '').trim();
    const rawModel = explicitModelSetting(config.provider, storedModel);
    const post = () => this._postMessage({
      type: 'configState',
      config: {
        provider: config.provider,
        endpoint: config.endpoint,
        model: rawModel,
        detectedModel: getDetectedModel(),
        activeModel: config.model,
        hasToken: hasApiKey(),
        trustedCommands: config.trustedCommands,
        confirmCommands: config.confirmCommands,
        contextSize: getContextSize(),
      },
    });
    post();
    // Always re-detect from the server — the context window changes if the
    // server is restarted with a different -c, and the served model can change
    // too — and re-send when either updates.
    const beforeCtx = getContextSize();
    const beforeModel = getDetectedModel();
    Promise.all([
      detectContextSize(config.endpoint),
      detectModel(config.endpoint),
    ]).then(() => {
      if (getContextSize() !== beforeCtx || getDetectedModel() !== beforeModel) { post(); }
    });
  }

  private async _handleSaveConfig(cfg: {
    provider?: string;
    endpoint?: string;
    model?: string;
    token?: string;
    trustedCommands?: string[];
    confirmCommands?: boolean;
  }): Promise<void> {
    const settings = vscode.workspace.getConfiguration('codeflare');
    // Provider must be written BEFORE the token — the token is stored per
    // provider, and setApiKey() keys off the now-active provider.
    if (cfg.provider === 'local' || cfg.provider === 'openai' || cfg.provider === 'anthropic') {
      await settings.update('provider', cfg.provider, vscode.ConfigurationTarget.Global);
    }
    if (typeof cfg.endpoint === 'string') {
      await settings.update('endpoint', cfg.endpoint.trim().replace(/\/+$/, ''), vscode.ConfigurationTarget.Global);
    }
    if (typeof cfg.model === 'string') {
      await settings.update('model', cfg.model.trim(), vscode.ConfigurationTarget.Global);
    }
    // Only touch the token when the field was actually provided:
    //  ''  → clear stored token, otherwise store the new one.
    if (typeof cfg.token === 'string') {
      await setApiKey(cfg.token.trim());
    }
    if (Array.isArray(cfg.trustedCommands)) {
      await settings.update('trustedCommands', cfg.trustedCommands, vscode.ConfigurationTarget.Global);
    }
    if (typeof cfg.confirmCommands === 'boolean') {
      await settings.update('confirmCommands', cfg.confirmCommands, vscode.ConfigurationTarget.Global);
    }

    log(`Config saved (endpoint set, token ${hasApiKey() ? 'present' : 'none'})`);

    // Re-detect the context window and the served model for the (possibly new)
    // endpoint before pushing the fresh config state back to the panel.
    await Promise.all([
      detectContextSize(getConfig().endpoint),
      detectModel(getConfig().endpoint),
    ]);
    this._sendConfigState();

    // Re-check connectivity against the new endpoint/token.
    const healthy = await this._client.checkHealth();
    this._postMessage({ type: 'statusUpdate', healthy });
    this._postMessage({ type: 'configSaved' });
  }

  async sendCodeAction(action: CodeAction, text: string, filePath: string, language: string): Promise<void> {
    if (this._busy) {
      vscode.window.showWarningMessage('CodeFlare is busy with another request — try again when it finishes.');
      return;
    }
    this._busy = true;
    this._stopRequested = false;

    // Mirror the chat path's per-turn state: reset change tracking and start a
    // fresh checkpoint with the pre-mutation recorder registered, so files the
    // agent mutates during a code-action turn are checkpointed (revertible) and
    // feed the verify/diagnostics/diff-review pipeline — and don't inherit the
    // previous chat turn's mutated set (which would spuriously trigger verify).
    this._turnChangedFiles = new Set();
    this._turnMutatedPaths = new Set();
    this._activeCheckpoint = { id: String(Date.now()), time: Date.now(), files: new Map() };
    setPreMutationRecorder((rel) => {
      if (rel) { this._turnMutatedPaths.add(rel.replace(/\\/g, '/')); }
      return this._captureCheckpoint(rel);
    });
    const cfgAction = getConfig();
    beginPolicyTurn({
      profile: cfgAction.autonomyProfile,
      paths: {
        allowedPaths: cfgAction.allowedPaths,
        protectedPaths: cfgAction.protectedPaths,
        forbiddenPaths: cfgAction.forbiddenPaths,
      },
      budgetOverrides: cfgAction.changeBudget,
    });

    // Same pre-turn setup as the chat path: refresh the project map and snapshot
    // the current errors so a verify/diagnostics round can isolate regressions.
    if (getConfig().repoMap) {
      setProjectMap(await getRepoMap());
    } else {
      setProjectMap('');
    }
    // Executables first: remembered "[exe]" facts can upgrade stack commands
    // (e.g. the Godot verify task bakes in the discovered binary path).
    const mem2 = await loadProjectMemory();
    setProjectMemory(mem2);
    if (loadExecutablesFromMemory(mem2)) { invalidateStacks(); }
    setProjectStacks(stacksPromptBlock(await getStacks()));
    this._errorBaseline = snapshotErrorSignatures();

    const context = gatherContext();

    // Override context with the specific selection
    if (context.activeFile) {
      context.activeFile.selection = {
        text,
        startLine: 0,
        endLine: 0,
        surroundingBefore: '',
        surroundingAfter: '',
      };
    }

    const systemPrompt = buildSystemPrompt(context, action);
    const userMessage = `${action}: \n\`\`\`${language}\n${text}\n\`\`\``;
    // The diff review judges the change against this turn's request.
    this._turnRequest = userMessage;

    this._postMessage({ type: 'addUserMessage', text: userMessage });
    this._history.push({ role: 'user', content: userMessage });
    this._transcript.push({ role: 'user', text: userMessage });
    this._persist();

    try {
      await this._streamResponse(systemPrompt, userMessage, context);
    } finally {
      this._finishCheckpoint();
      endPolicyTurn();
      this._busy = false;
      const next = this._queue.shift();
      if (next) { void this._handleUserMessage(next.text, next.images, next.files); }
    }
  }

  async sendSelectionToChat(text: string): Promise<void> {
    const editor = resolveActiveEditor();
    const language = editor?.document.languageId || 'plaintext';
    const message = `Here's the code I'm working with:\n\`\`\`${language}\n${text}\n\`\`\``;

    this._postMessage({ type: 'addUserMessage', text: message });
    this._history.push({ role: 'user', content: message });
    this._transcript.push({ role: 'user', text: message });
    this._persist();
  }

  clearChat(): void {
    // Bump the epoch so a turn finishing after this clear drops its pending
    // history writes instead of repopulating the cleared conversation.
    this._historyEpoch++;
    this._history = [];
    this._transcript = [];
    this._todos = [];
    this._persist();
    this._postMessage({ type: 'chatCleared' });
  }

  private async _handleUserMessage(
    text: string,
    images?: string[],
    files?: { name: string; content: string }[]
  ): Promise<void> {
    // Re-entrancy guard: a second send while a turn is running would interleave
    // two agent loops in one history (corrupting tool pairing). Queue it instead.
    if (this._busy) {
      this._queue.push({ text, images, files });
      this._postMessage({ type: 'notice', text: 'CodeFlare is still working — your message is queued and will run next.' });
      return;
    }
    this._busy = true;
    this._stopRequested = false;

    // Start this turn's metrics (recorded to .codeflare/metrics.jsonl at the end).
    const cfg0 = getConfig();
    this._turnMetrics = cfg0.metrics ? newTurnMetrics(cfg0.model, cfg0.provider) : undefined;
    this._turnChangedFiles = new Set();
    this._turnRequest = text;
    // The experiment record + chronological run log for this turn. The record
    // annotates what the loop does; at turn end an acceptance decision is made
    // fail-closed and both are persisted under .codeflare/.
    this._experiment = newExperiment(text, cfg0.model, cfg0.provider);
    this._runLog = new TurnRunLog(text, cfg0.model, cfg0.provider);

    // Project instructions (CODEFLARE.md) are re-read each turn — cheap, and
    // edits to the file take effect immediately.
    await this._loadProjectInstructions();
    await this._loadVerificationConfig();
    this._metricBaseline = undefined;
    this._metricBaselinePromise = undefined;

    // Refresh the project map (cached; rebuilds only when files changed) so the
    // model sees what exists and can match conventions. And snapshot the current
    // error set so the verify step can later isolate regressions this turn caused.
    // Keep the map text (files + top-level symbols) — it's the haystack the
    // grounding check searches for the request's concepts, built once here.
    // Only build it if something actually needs it (the map or the grounding check).
    const needMap = getConfig().repoMap || getConfig().clarifyAmbiguity;
    const mapText = needMap ? await getRepoMap() : '';
    setProjectMap(getConfig().repoMap ? mapText : '');
    // Load durable project facts the agent proved in earlier conversations, and
    // re-trust any executables it discovered before (so they still skip
    // prompts). This runs BEFORE stack detection: remembered executables can
    // upgrade stack commands (e.g. the Godot verify task bakes in the path).
    const mem = await loadProjectMemory();
    setProjectMemory(mem);
    if (loadExecutablesFromMemory(mem)) { invalidateStacks(); }
    // Detect the project's stacks (per module) so the model sees how to build/
    // verify each part with the project's own commands.
    setProjectStacks(stacksPromptBlock(await getStacks()));
    this._errorBaseline = snapshotErrorSignatures();

    // Start a fresh checkpoint for this turn: the first write to each file
    // stores its pre-state so the whole turn can be reverted. Register the
    // recorder so EVERY mutating file tool (create/edit/move/delete/…) captures
    // its pre-state itself — the agent loop no longer sniffs tool names.
    this._activeCheckpoint = { id: String(Date.now()), time: Date.now(), files: new Map() };
    this._turnMutatedPaths = new Set();
    setPreMutationRecorder(async (rel) => {
      // Metric baseline (verification.json) is captured just BEFORE the first
      // mutation of the turn — after it, the pre-change state is gone.
      await this._captureMetricBaseline();
      if (rel) { this._turnMutatedPaths.add(rel.replace(/\\/g, '/')); }
      return this._captureCheckpoint(rel);
    });

    // Arm the deterministic policy gate for this turn (budgets + path rules).
    beginPolicyTurn({
      profile: cfg0.autonomyProfile,
      paths: {
        allowedPaths: cfg0.allowedPaths,
        protectedPaths: cfg0.protectedPaths,
        forbiddenPaths: cfg0.forbiddenPaths,
      },
      budgetOverrides: cfg0.changeBudget,
    });

    // Autonomous profiles run the experiment on an isolated git branch so the
    // known-good branch is never mutated directly. A dirty tree or missing
    // repo means weaker (checkpoint-only) isolation — reported, never hidden.
    this._isolation = undefined;
    if (cfg0.autonomyProfile !== 'interactive' && !this._verifyOnlyTurn) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (root && this._experiment) {
        const iso = await beginIsolation(root.fsPath, this._experiment.id);
        if (iso.ok) {
          this._isolation = iso.isolation;
          this._experiment.isolation = { ...iso.isolation };
          this._postMessage({ type: 'toolActivity', label: `isolation: experiment branch ${iso.isolation.branch}` });
          log(`Git isolation: on ${iso.isolation.branch} (base ${iso.isolation.baseBranch}@${iso.isolation.baseCommit.slice(0, 8)})`);
        } else {
          this._postMessage({ type: 'toolActivity', label: `isolation: checkpoint-only — ${iso.reason}` });
          this._runLog?.append('note', { note: `isolation unavailable: ${iso.reason}` });
          log(`Git isolation unavailable: ${iso.reason}`);
        }
      }
    }

    // Text attachments are folded into the message the model sees (but not the
    // chat bubble, which shows only the typed text + file chips).
    let modelText = text;
    if (files && files.length > 0) {
      for (const f of files) {
        modelText += `\n\n--- Attached file: ${f.name} ---\n\`\`\`\n${f.content}\n\`\`\``;
      }
    }

    // @file mentions: fold the referenced files into the model's message the
    // same way (the bubble keeps showing just the typed @path).
    modelText += await this._expandFileMentions(text);

    // Store the user turn (with images as content parts) so follow-up turns
    // keep the visual/file context.
    if (images && images.length > 0) {
      this._history.push({
        role: 'user',
        content: [
          { type: 'text', text: modelText },
          ...images.map(url => ({ type: 'image_url' as const, image_url: { url } })),
        ],
      });
    } else {
      this._history.push({ role: 'user', content: modelText });
    }

    // Display transcript (typed text + attachment names, not the folded dump).
    this._transcript.push({
      role: 'user',
      text,
      ...(images && images.length ? { images } : {}),
      ...(files && files.length ? { files: files.map(f => f.name) } : {}),
    });
    this._persist();

    const context = gatherContext();
    // Grounding evidence for the ambiguity gate: which emphasized terms from the
    // request don't appear anywhere in the codebase (searched against the repo
    // map — file paths + top-level symbols). Folded into this turn's system
    // prompt, then cleared so it never repeats in fix rounds.
    if (getConfig().clarifyAmbiguity) {
      setGroundingNote(groundingConcerns(text, mapText));
    }
    // Advisory review request → shape the output as calibrated findings (with
    // confidence/impact/evidence/compat-risk) and stay advisory. Per turn.
    setReviewMode(looksLikeReviewRequest(text));
    const systemPrompt = buildSystemPrompt(context);
    setGroundingNote([]);
    setReviewMode(false);

    try {
      await this._streamResponse(systemPrompt, modelText, context, images);
    } finally {
      this._finishCheckpoint();
      endPolicyTurn();
      // Decide + persist the experiment BEFORE metrics are cleared (it reads
      // the round count from them). Awaited: git isolation must settle before
      // the next queued turn can start on a half-switched tree.
      await this._finalizeExperiment(this._stopRequested ? 'stopped' : 'completed');
      // Record this turn's metrics (best-effort; never blocks the next message).
      if (this._turnMetrics) {
        this._turnMetrics.filesChanged = this._turnChangedFiles.size;
        this._turnMetrics.outcome = this._stopRequested ? 'stopped' : 'completed';
        // A manual Stop mid-turn is the user correcting/aborting the agent.
        if (this._stopRequested) { this._turnMetrics.interventions.correction++; }
        void flushTurnMetrics(this._turnMetrics);
        this._turnMetrics = undefined;
      }
      this._busy = false;
      const next = this._queue.shift();
      if (next) { void this._handleUserMessage(next.text, next.images, next.files); }
    }
  }

  /**
   * Close out this turn's experiment record: make the fail-closed acceptance
   * decision, surface an honest verification chip, and persist the experiment
   * + chronological run log under .codeflare/. Best-effort — never blocks.
   */
  private async _finalizeExperiment(outcome: 'completed' | 'stopped' | 'error'): Promise<void> {
    const exp = this._experiment;
    const runLog = this._runLog;
    this._experiment = undefined;
    this._runLog = undefined;
    if (!exp) { return; }
    try {
      exp.endedAt = Date.now();
      exp.outcome = outcome;
      exp.attempts = Math.max(0, (this._turnMetrics?.rounds ?? exp.attempts) - 1);
      exp.filesChanged = [...this._turnMutatedPaths];
      exp.evidence = this._turnEvidence.slice();
      exp.gates = { ...this._turnGates };

      // A verification-only turn (Prove It / Break My Solution) never decides
      // acceptance — it reports what the fresh evidence demonstrated.
      if (this._verifyOnlyTurn) {
        const s = verificationSummary(exp.evidence);
        const failed = s.behavioralFailed + s.checksFailed;
        exp.state = failed > 0 ? 'REJECTED' : 'VERIFYING';
        exp.decisionReasons = [`verification-only turn: ${s.label}, ${s.behavioral} behavioural, ` +
          `${s.checks} checks, ${failed} failed`];
        this._postMessage({
          type: 'toolActivity',
          label: `verification: ${failed > 0 ? '✗ evidence FAILED' : s.label} — ` +
            `${s.behavioral} behavioural, ${s.checks} checks${failed ? `, ${failed} failed` : ''}`,
        });
        runLog?.append('decision', { verifyOnly: true, summary: exp.decisionReasons[0] });
      } else if (this._planAwaitingReview) {
        // A turn that paused for plan review decided nothing — record it as
        // still-executing and skip the decision chip.
        exp.state = 'EXECUTING';
        runLog?.append('note', { note: 'paused for plan review' });
      } else {
        const { decision, reasons } = decideAcceptance({
          gates: exp.gates,
          evidence: exp.evidence,
          filesChanged: exp.filesChanged.length,
          outcome,
          behaviorRequired: this._requestWantsBehaviorVerification(),
        });
        exp.decision = decision;
        exp.decisionReasons = reasons;
        exp.state = stateForDecision(decision);
        runLog?.append('decision', { decision, reasons });

        // Honest, compact verification chip — only for turns that changed files
        // (question-answering turns have nothing to decide).
        if (exp.filesChanged.length > 0) {
          const s = verificationSummary(exp.evidence);
          const label = decision === 'ACCEPTED'
            ? `✓ ${decision} — ${s.label.toLowerCase()} (${s.behavioral} behavioural, ${s.checks} checks)`
            : `${decision === 'REJECTED' ? '✗' : '?'} ${decision}${reasons.length ? ` — ${reasons[0]}` : ''}`;
          this._postMessage({ type: 'toolActivity', label: `experiment: ${label}` });
        }
      }
      // Resolve git isolation according to the decision. Awaited so the next
      // turn never starts while the tree is mid-switch.
      const iso = this._isolation;
      this._isolation = undefined;
      if (iso) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (root) {
          const msg = `codeflare experiment ${exp.id}: ${exp.task.slice(0, 60).replace(/\s+/g, ' ')} ` +
            `[${exp.decision ?? exp.state}]`;
          const fin = exp.decision === 'ACCEPTED'
            ? await acceptIsolation(root.fsPath, iso, msg)
            : exp.decision === 'REJECTED'
              ? await rejectIsolation(root.fsPath, iso, msg)
              : await parkIsolation(root.fsPath, iso, msg);
          if (exp.isolation) { exp.isolation.outcome = fin.detail; }
          this._postMessage({
            type: 'toolActivity',
            label: `isolation: ${fin.ok ? '' : '⚠ '}${fin.detail}`,
          });
          runLog?.append('note', { note: `isolation: ${fin.detail}` });
          log(`Git isolation finish (${exp.decision ?? exp.state}): ${fin.detail}`);
        }
      }

      this._lastExperiment = exp;
      void appendExperiment(exp);
      void runLog?.flush();
    } catch (err: any) {
      log(`Experiment finalize failed: ${err.message}`);
    }
  }

  /**
   * PROVE IT — independently verify the last turn's outcome. Runs as a
   * WRITE-LOCKED turn (no file tools, no probes, no subagents — enforced in
   * the tool set, not the prompt): the agent may only build, test, run,
   * benchmark, screenshot and inspect, then report what the evidence shows.
   */
  async proveIt(): Promise<void> {
    const exp = this._lastExperiment;
    if (this._busy) {
      this._postMessage({ type: 'notice', text: 'CodeFlare is still working — try Prove It when the turn finishes.' });
      return;
    }
    if (!exp || exp.filesChanged.length === 0) {
      this._postMessage({ type: 'notice', text: 'Nothing to prove yet — the last turn changed no files.' });
      return;
    }
    const instruction =
      `PROVE IT (automated verification request): independently verify the previous change — do not ` +
      `trust the earlier turn's claims.\n\n` +
      `ORIGINAL TASK:\n${exp.task}\n\nFILES CHANGED: ${exp.filesChanged.join(', ')}\n\n` +
      `File-editing tools are DISABLED for this turn — gather evidence only:\n` +
      `1. Run the project's build/typecheck and relevant tests (run_command).\n` +
      `2. Exercise the actual behaviour the task asked for (run the code: run_command / lab_run; ` +
      `for visual results: screenshot + verify_visual).\n` +
      `3. Check diagnostics on the changed files (get_diagnostics).\n\n` +
      `Then report a checklist — one line per check: ✓ (verified), ✗ (failed), or ? (could not be ` +
      `verified here, say why). End with VERIFICATION: SUPPORTED, FAILED, or INCOMPLETE. Never mark ` +
      `✓ without having run the check this turn.`;
    this._postMessage({ type: 'addUserMessage', text: '🔎 Prove It — independently verify the last change' });
    this._postMessage({ type: 'toolActivity', label: 'PROVE IT: write tools disabled — gathering evidence' });
    this._verifyOnlyTurn = true;
    try {
      await this._handleUserMessage(instruction);
    } finally {
      this._verifyOnlyTurn = false;
    }
  }

  /**
   * BREAK MY SOLUTION — adversarial pass over the last change. Also
   * write-locked: the agent designs scenarios intended to make the solution
   * fail and EXECUTES them (lab, commands); a surviving solution earns
   * evidence, a counterexample is a finding, not a failure of the exercise.
   */
  async breakMySolution(): Promise<void> {
    const exp = this._lastExperiment;
    if (this._busy) {
      this._postMessage({ type: 'notice', text: 'CodeFlare is still working — try Break My Solution when the turn finishes.' });
      return;
    }
    if (!exp || exp.filesChanged.length === 0) {
      this._postMessage({ type: 'notice', text: 'Nothing to attack yet — the last turn changed no files.' });
      return;
    }
    const instruction =
      `BREAK MY SOLUTION (automated adversarial request): actively try to FALSIFY the previous ` +
      `change — your job this turn is to make it fail, not to defend it.\n\n` +
      `ORIGINAL TASK:\n${exp.task}\n\nFILES CHANGED: ${exp.filesChanged.join(', ')}\n\n` +
      `File-editing tools are DISABLED for this turn. Procedure:\n` +
      `1. Read the changed code and list the 3-6 most promising failure scenarios (edge inputs: ` +
      `empty, negative, huge, duplicates, unicode, malformed; boundary conditions; concurrent/ordering ` +
      `assumptions; states the fix did not consider).\n` +
      `2. EXECUTE each scenario where possible: lab_run / lab_diff_test with an adversarial ` +
      `generator / run_command against the real project. A scenario you cannot execute stays listed ` +
      `as UNTESTED — that is a finding too.\n` +
      `3. Report per scenario: BROKE IT (with the failing input and output), SURVIVED, or UNTESTED.\n` +
      `End with: counterexamples found (n) / solution survived all executed scenarios. Do not soften ` +
      `findings; a found counterexample is the SUCCESSFUL outcome of this exercise.`;
    this._postMessage({ type: 'addUserMessage', text: '🔨 Break My Solution — adversarial pass on the last change' });
    this._postMessage({ type: 'toolActivity', label: 'BREAK MY SOLUTION: write tools disabled — attacking' });
    this._verifyOnlyTurn = true;
    try {
      await this._handleUserMessage(instruction);
    } finally {
      this._verifyOnlyTurn = false;
    }
  }

  /** Read CODEFLARE.md (or .codeflare.md) from the workspace root into the prompt. */
  private async _loadProjectInstructions(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) { setProjectInstructions(''); return; }
    // Compatibility: mirror a standard agent-instructions file into CODEFLARE.md
    // so existing projects work without renaming. Creates CODEFLARE.md if absent
    // and refreshes it when the source is newer — otherwise we always read our
    // own CODEFLARE.md below.
    await this._syncAgentInstructions(root);
    for (const name of ['CODEFLARE.md', '.codeflare.md', 'codeflare.md']) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, name));
        let text = new TextDecoder().decode(bytes).trim();
        if (!text) { continue; }
        if (text.length > 6000) { text = text.slice(0, 6000) + '\n… (truncated at 6000 chars)'; }
        setProjectInstructions(text);
        return;
      } catch { /* not present — try the next name */ }
    }
    setProjectInstructions('');
  }

  /**
   * For projects that already ship agent instructions under a standard name,
   * mirror the first of .claude/CLAUDE.md, CLAUDE.md or AGENTS.md into
   * CODEFLARE.md. Only writes when CODEFLARE.md is missing or older than the
   * source (compared by mtime), so hand edits to CODEFLARE.md survive until the
   * source file is touched again. CODEFLARE.md stays the single file the prompt
   * reads.
   */
  private async _syncAgentInstructions(root: vscode.Uri): Promise<void> {
    const sourceNames = ['.claude/CLAUDE.md', 'CLAUDE.md', 'AGENTS.md'];
    let source: { uri: vscode.Uri; name: string; mtime: number } | undefined;
    for (const rel of sourceNames) {
      const uri = vscode.Uri.joinPath(root, ...rel.split('/'));
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        source = { uri, name: rel, mtime: stat.mtime };
        break;
      } catch { /* not present — try the next name */ }
    }
    if (!source) { return; }

    const target = vscode.Uri.joinPath(root, 'CODEFLARE.md');
    try {
      const targetStat = await vscode.workspace.fs.stat(target);
      // CODEFLARE.md exists and is at least as new as the source → leave it.
      if (targetStat.mtime >= source.mtime) { return; }
    } catch { /* target missing → fall through and create it */ }

    try {
      const body = new TextDecoder().decode(await vscode.workspace.fs.readFile(source.uri));
      const header = `<!-- Auto-synced from ${source.name} by CodeFlare. ` +
        `Overwritten whenever ${source.name} changes; edit the source, not this file. -->\n\n`;
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(header + body));
      log(`Synced ${source.name} → CODEFLARE.md`);
    } catch (e) {
      log(`Failed to sync agent instructions: ${e}`);
    }
  }

  /**
   * Expand @path mentions in the typed text: each mention that resolves to a
   * real workspace file gets its content appended (for the model only).
   */
  private async _expandFileMentions(text: string): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) { return ''; }
    const mentions = [...new Set(
      [...text.matchAll(/@([\w\-./\\]+\.[\w]+)/g)].map(m => m[1].replace(/\\/g, '/'))
    )].slice(0, 8);
    let out = '';
    for (const rel of mentions) {
      if (rel.includes('..')) { continue; }
      try {
        const uri = vscode.Uri.joinPath(root, rel);
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type !== vscode.FileType.File || stat.size > 512 * 1024) { continue; }
        let content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        if (content.length > 24000) { content = content.slice(0, 24000) + '\n… (truncated)'; }
        out += `\n\n--- Mentioned file @${rel} ---\n\`\`\`\n${content}\n\`\`\``;
        log(`Attached @mention: ${rel} (${content.length} chars)`);
      } catch { /* not a real file — leave the mention as plain text */ }
    }
    return out;
  }

  private async _streamResponse(systemPrompt: string, userMessage: string, context?: import('../editor/contextGatherer').EditorContext, images?: string[], round: number = 0): Promise<void> {
    const config = getConfig();
    if (this._turnMetrics) { this._turnMetrics.rounds++; }
    // Snapshot the history epoch: if the user clears the chat while this turn
    // runs, the epoch bumps and every history write below is skipped, so the
    // cleared conversation isn't repopulated with this turn's orphaned messages.
    const startEpoch = this._historyEpoch;
    // Fresh turn → forget which verify steps were already green last turn.
    if (round === 0) { this._verifiedSteps.clear(); this._turnEvidence = []; this._turnGates = {}; }
    if (this._experiment) { this._experiment.state = round === 0 ? 'EXECUTING' : 'VERIFYING'; }
    this._runLog?.append('round', { round });

    // Before a fresh turn, auto-compact the conversation if it has grown large:
    // summarize older turns into one note, keep recent turns verbatim.
    if (round === 0) {
      await this._maybeCompactContext();
    }

    // Working message list for this turn — the agent loop appends tool calls
    // and tool results to it as the model explores the workspace.
    const messages = buildMessages(systemPrompt, this._history.slice(0, -1), userMessage, context, images);
    // A verification-only turn (Prove It / Break My Solution) is WRITE-LOCKED
    // at the runtime level: no file tools, no probes — observation and
    // execution only. The lock is enforced here, not by the prompt.
    const tools = config.agentMode
      ? getToolDefinitions({
          write: config.agentEdit && !this._verifyOnlyTurn,
          run: config.agentRunCommands,
          web: config.webAccess,
          subagent: !this._verifyOnlyTurn,
          probes: config.agentProbes && !this._verifyOnlyTurn,
          debug: config.agentDebug,
          vision: config.visualVerify,
        })
      : undefined;

    this._postMessage({ type: 'streamStart' });
    log(`Streaming response (${messages.length} messages, agentMode=${config.agentMode}, round=${round})`);

    let fullResponse = '';
    let hadError = false;
    // Tool calls + their results this turn — persisted into history so the
    // model remembers what it already read/wrote and doesn't re-read it.
    const turnMessages: ChatMessage[] = [];
    // Persist the turn's tool exchanges even on an EARLY/ERROR exit. Without
    // this, a mid-turn stream error drops every tool message from history while
    // the files stay written on disk — a follow-up "continue" then re-runs the
    // same edits and corrupts the file. Idempotent (a normal finish sets the
    // flag), and only ever called before the normal push happens, so it never
    // inverts order against the recursive fix-round pushes.
    let turnPersisted = false;
    const persistTurnMessages = () => {
      if (turnPersisted || turnMessages.length === 0) { return; }
      if (this._historyEpoch !== startEpoch) { turnPersisted = true; return; }
      this._history.push(...turnMessages);
      turnPersisted = true;
      this._persist();
    };
    // Files this turn wrote — checked for problems after the agent finishes.
    const writtenPaths = new Set<string>();
    // Image files produced by successful run_command calls (generator scripts)
    // — they bypass the write tools but must still get previewed and QC'd.
    const commandImages = new Set<string>();
    // Bounded nudges to keep the model going when it narrates instead of acting.
    let nudges = 0;
    const MAX_NUDGES = 4;
    // One-shot recovery when the model quits silently on a task it never
    // planned (no todos to nudge against, files written, no final summary).
    let planlessNudges = 0;
    // One-shot reminder when the model dives into a big task without a plan.
    let planReminded = false;
    // Consecutive completely-empty replies (no text, no reasoning, no tool
    // call) — the local model choking, usually on a large context. Retry a
    // couple of times with a minimal prod, then stop with a VISIBLE message
    // instead of spinning through plan-nudges and ending the turn blank.
    let emptyResponses = 0;
    const MAX_EMPTY_RETRIES = 2;
    // Distinguish "ran out of steps" from "model stopped early" for the note.
    let stepsUsed = 0;
    // Step budget. It auto-extends (bounded) when the limit hits while the plan
    // is still open AND write activity happened since the previous extension —
    // a healthy long build must not be abandoned mid-way by a step counter.
    // Counted as write EVENTS, not unique paths: a debugging phase re-editing
    // the same files over and over is real progress too.
    let budget = config.agentMaxSteps;
    let writeEvents = 0;
    let extensionWrites = 0;
    // Bounded retries when a create_file is too large and gets truncated.
    let chunkRetries = 0;
    const MAX_CHUNK_RETRIES = 3;
    // Successful write calls this turn (name + exact arguments). Local models
    // sometimes repeat a call that already succeeded; re-executing a write
    // duplicates content and corrupts files, so identical repeats are skipped.
    const doneWrites = new Map<string, string>();
    // Set when the deterministic change budget trips — the turn ends after the
    // current tool batch (every call in the batch still gets a result so
    // tool-call pairing stays valid).
    let budgetStop = '';
    // Set when a fresh plan pauses this turn for user review.
    let pausedForPlan = false;
    this._planAwaitingReview = false;
    this._currentRound = round;
    if (round === 0) {
      this._planCallsThisTurn = 0;
      this._approvalTurn = /^Plan approved\b/i.test(userMessage.trim());
      this._qcReported.clear();
    }

    // Is this an explicit plan-execution turn ("Plan approved", "continue", "ga
    // door", …)? Only then may a stall fall back to "continue your plan". A
    // fresh follow-up (a question, a bug/error report) must be addressed on its
    // own terms — never buried under stale-plan reminders.
    const planDrivenTurn = this._approvalTurn ||
      /^(continue|resume|proceed|go on|keep going|ga door|ga verder|verder|doorgaan)\b/i.test(userMessage.trim());

    try {
      for (let step = 0; step < budget; step++) {
        stepsUsed = step + 1;
        if (this._turnMetrics) { this._turnMetrics.steps++; }
        if (this._stopRequested) { break; }

        // About to run the LAST budgeted step while the turn keeps producing
        // files — extend up-front. Counts both an OPEN plan and NO plan at all
        // (models regularly skip update_todos); the writes-since-last-extension
        // requirement is what guards against runaway loops either way.
        if (step === budget - 1 &&
            (this._todos.length === 0 || todosIncomplete(this._todos)) &&
            writeEvents > extensionWrites && budget < config.agentMaxSteps * 4) {
          extensionWrites = writeEvents;
          budget += config.agentMaxSteps;
          this._postMessage({
            type: 'toolActivity',
            label: `step limit reached — plan still in progress, extending (+${config.agentMaxSteps} steps)`,
          });
          log(`Agent step budget extended to ${budget} (plan incomplete, files still being written)`);
        }
        let stepText = '';
        let lastProgress = 0;
        let lastProgressLog = 0;
        const result = await this._client.streamChat(messages, {
          onToken: (token) => {
            fullResponse += token;
            stepText += token;
            this._postMessage({ type: 'streamToken', token });
          },
          onThinking: (text) => {
            this._postMessage({ type: 'streamThinking', text });
          },
          onToolProgress: (info) => {
            // Throttle: only report every ~600 chars of tool-argument growth.
            if (info.chars - lastProgress >= 600 || (lastProgress === 0 && info.chars > 0)) {
              lastProgress = info.chars;
              this._postMessage({ type: 'toolProgress', name: info.name, chars: info.chars });
            }
            // Breadcrumb in the extension log so a copy-log taken during a long
            // generation shows what the plugin was doing, not just silence.
            if (info.chars - lastProgressLog >= 8000) {
              lastProgressLog = info.chars;
              log(`Generating ${info.name || 'tool call'}: ${Math.round(info.chars / 1000)}k chars so far`);
            }
          },
          onWaiting: (info) => {
            this._postMessage({ type: 'waiting', seconds: info.seconds, promptTokens: info.promptTokens });
            // Same breadcrumb for long prompt (re-)evaluations.
            if (info.seconds % 30 < 10) {
              log(`Waiting for server response: ${info.seconds}s (prompt ~${Math.round(info.promptTokens / 1000)}k tokens)`);
            }
          },
          onDone: () => { /* per-step end handled below */ },
          onError: (error) => {
            hadError = true;
            this._postMessage({ type: 'streamError', error });
            log(`Stream error: ${error}`);
          },
        }, tools);

        // Feed the footer: context usage + generation speed of this step.
        if (result.stats) {
          this._postMessage({
            type: 'turnStats',
            promptTokens: result.stats.promptTokens,
            completionTokens: result.stats.completionTokens,
            genSeconds: result.stats.genSeconds,
            contextWindow: getContextSize() ?? 0,
          });
          if (this._turnMetrics) {
            this._turnMetrics.promptTokens += result.stats.promptTokens;
            this._turnMetrics.completionTokens += result.stats.completionTokens;
          }
        }

        if (hadError) { persistTurnMessages(); return; }
        // User pressed Stop mid-request: don't execute partial tool calls,
        // don't nudge — end the turn here.
        if (this._stopRequested) { break; }

        // The overthink guard cut off a reasoning spiral (no action was taken).
        // That's recoverable — push the model to act instead of killing the turn.
        if (result.finishReason === 'overthink') {
          if (nudges < MAX_NUDGES && step < budget - 1) {
            nudges++;
            this._postMessage({ type: 'toolActivity', label: 'reasoning ran long — pushing the model to act' });
            log('Overthink abort — nudging the model to act instead of deliberating');
            messages.push({ role: 'assistant', content: '(reasoning was cut off — no action taken)' });
            messages.push({
              role: 'user',
              content: 'Your hidden reasoning ran too long and was CUT OFF — nothing was executed. ' +
                'Do NOT deliberate further. Immediately issue the next tool call for the current step ' +
                'of the plan.',
            });
            fullResponse = '';
            continue;
          }
          this._postMessage({
            type: 'streamError',
            error: 'The model got stuck reasoning repeatedly and was stopped. Try a more specific request.',
          });
          persistTurnMessages();
          return;
        }

        // A big create_file got truncated → nothing was written. Recover by
        // asking the model to write the file in small parts, then retry. Also
        // treat finish_reason 'length' WITH tool calls as truncated — the
        // arguments are almost certainly cut off; executing them could write a
        // half file.
        if (result.finishReason === 'tool_call_truncated' ||
            (result.finishReason === 'length' && result.toolCalls.length > 0)) {
          if (chunkRetries < MAX_CHUNK_RETRIES) {
            chunkRetries++;
            this._postMessage({ type: 'toolActivity', label: 'file too large — retrying in smaller parts' });
            messages.push({
              role: 'user',
              content: 'Your last create_file exceeded the output token limit and was cut off, so ' +
                'NOTHING was written. Write that file in SMALL parts: call create_file with only the ' +
                'first ~120 lines, then use edit_file to append the rest in chunks (search the last ' +
                'lines you just wrote and replace them with themselves plus the next chunk). Never put ' +
                'a whole large file in a single create_file call. Also prefer more compact code.',
            });
            fullResponse = '';
            continue;
          }
          this._postMessage({
            type: 'streamError',
            error: 'A file was too large to write even after retrying in parts. Ask for smaller files or fewer features per file.',
          });
          persistTurnMessages();
          return;
        }

        // Plain answer hit the output token limit — tell the user it may be cut off.
        if (result.finishReason === 'length' && result.toolCalls.length === 0) {
          this._postMessage({ type: 'toolActivity', label: '⚠ output hit the token limit — the reply may be cut off' });
        }

        // No tool calls, but the plan still has open steps. Nudge the model to
        // keep going — this often triggers a valuable self-review that fixes real
        // bugs. Bounded by MAX_NUDGES. The message also lets it close out steps it
        // can't perform here (e.g. "test in a browser") so it doesn't loop.
        if (result.toolCalls.length === 0) {
          log(`Agent step ${step + 1}: no tool calls (finish=${result.finishReason || 'stop'}, ${stripThink(result.content).trim().length} chars text)`);

          // The model sometimes emits its tool call as LITERAL TEXT into the
          // reasoning channel (<tool_call><function=…>) — the server can't
          // parse that, so nothing executes. That's still an ATTEMPT to act, so
          // handle it before the stall check below and push it to re-issue.
          if (/<tool_call>|<function=/i.test(result.reasoning + result.content) &&
              nudges < MAX_NUDGES && step < budget - 1) {
            nudges++;
            this._postMessage({ type: 'toolActivity', label: 'tool call came out as text — retrying' });
            log('Detected tool call leaked as plain text — nudging the model to re-issue it');
            messages.push({ role: 'assistant', content: stripThink(result.content) || '(malformed tool call)' });
            messages.push({
              role: 'user',
              content: 'Your last tool call came out as PLAIN TEXT (with <tool_call> markup) and was ' +
                'NOT executed. Re-issue it as a REAL tool call — no markup in your text — and continue ' +
                'with the task.',
            });
            fullResponse = '';
            continue;
          }

          const textLen = stripThink(result.content).trim().length;
          const didWorkThisTurn = writtenPaths.size > 0 || turnMessages.some(m => m.role === 'tool');
          // "Plan context" = the model is actively executing a plan (an explicit
          // plan-driven turn, or it already did tool work this turn). Only then
          // does a stall mean "keep going on the plan".
          const planContext = planDrivenTurn || didWorkThisTurn;

          // STALLED on the user's latest message: no tool call, no text, and NOT
          // in a plan-execution flow. This is the case that used to break — a
          // follow-up like a bug/error report got buried under stale "continue
          // your plan" reminders and the model spun out empty. Point it straight
          // at the user's message (an error → fix it) and retry, bounded.
          if (textLen === 0 && !planContext) {
            emptyResponses++;
            if (emptyResponses <= MAX_EMPTY_RETRIES && step < budget - 1) {
              this._postMessage({ type: 'toolActivity', label: 'no answer yet — retrying' });
              log(`Stalled on a non-plan turn (${emptyResponses}/${MAX_EMPTY_RETRIES}) — nudging to address the user's message`);
              messages.push({
                role: 'user',
                content: 'You produced no answer and called no tool. Respond to my LAST message now. ' +
                  'If it is an error or stack trace, open the file it names, find the cause, and fix it ' +
                  'with edit_file (a targeted change — do not rewrite the whole file). Otherwise answer ' +
                  'directly. Act by calling a tool.',
              });
              fullResponse = '';
              continue;
            }
            // Retries exhausted — end the turn; the end-of-loop guard surfaces a
            // clear notice so the user is never left staring at a dead spinner.
            break;
          }

          // No tool calls, but the plan still has open steps AND we're executing
          // that plan — nudge the model to keep going. Bounded by MAX_NUDGES.
          const incomplete = this._todos.length > 0 && todosIncomplete(this._todos);
          if (incomplete && planContext && nudges < MAX_NUDGES && step < budget - 1) {
            nudges++;
            this._postMessage({ type: 'toolActivity', label: 'continuing plan…' });

            // A cut-off text dump must NOT go back into context: the model would
            // see its own "created files" prose, believe the work is done, and
            // redo/skip steps. Stub it and say explicitly that nothing happened.
            const wasCutOff = result.finishReason === 'length';
            messages.push({
              role: 'assistant',
              content: wasCutOff
                ? stripThink(result.content).slice(0, 600) + '\n…[response was cut off at the output token limit]'
                : stripThink(result.content),
            });
            messages.push({
              role: 'user',
              content: wasCutOff
                ? 'Your last reply was PLAIN TEXT and hit the output token limit — it was cut off and ' +
                  'NOTHING was executed or written. Never dump file contents as text. Continue by ' +
                  'CALLING TOOLS (create_file / edit_file / run_command), one file per call.'
                : 'AUTOMATED REMINDER (not user feedback): your plan still has open steps. First, ' +
                  're-read the files you created and FIX any bugs (logic errors, wrong keys/paths, ' +
                  'duplicated lines) by calling edit_file — do NOT rewrite or redesign working code. ' +
                  'If a remaining step cannot be done here (e.g. "test by opening in a browser"), mark it ' +
                  'completed via update_todos. Do the work by calling tools — do not just describe it. ' +
                  'When everything is truly done, give a final summary.',
            });
            fullResponse = '';
            continue;
          }

          // The model stopped with NO plan at all, yet it did tool work this
          // turn and gave no real closing summary — the classic silent quit on
          // a task it never planned. Give it one recovery push. Only when the
          // todo list is EMPTY: a fully completed plan is a normal finish, and
          // nudging then makes the model "improve" working code.
          if (round === 0 && this._todos.length === 0 &&
              (writtenPaths.size > 0 || turnMessages.some(m => m.role === 'tool')) &&
              planlessNudges < 1 && stripThink(result.content).trim().length < 200 &&
              step < budget - 1) {
            planlessNudges++;
            this._postMessage({ type: 'toolActivity', label: 'checking task completeness…' });
            messages.push({ role: 'assistant', content: stripThink(result.content) || '(no reply)' });
            messages.push({
              role: 'user',
              content: 'AUTOMATED COMPLETENESS CHECK — this is NOT user feedback and NOT criticism of ' +
                'your work. Do NOT redesign, rewrite or "improve" anything that already works. Simply ' +
                'compare what you built against the ORIGINAL request above: if required files or features ' +
                'are still MISSING, call update_todos with the full plan (mark finished items completed) ' +
                'and create only what is missing. If everything is already there, just reply with a short ' +
                'final summary of what was created and how to run it.',
            });
            fullResponse = '';
            continue;
          }
          break;
        }

        // Record the assistant's tool-call turn (strip <think> from history).
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: stripThink(result.content),
          tool_calls: result.toolCalls,
        };
        messages.push(assistantMsg);
        turnMessages.push(assistantMsg);

        // Execute each tool and feed the result back to the model.
        for (const call of result.toolCalls) {
          const label = describeToolCall(call.function.name, call.function.arguments);
          this._postMessage({
            type: 'toolActivity', label,
            copy: copyableCommand(call.function.name, call.function.arguments),
          });
          log(`Agent step ${step + 1}: ${label}`);
          // Capture the file's current content before a write, so we can show a
          // real diff of what changed (works even when the model regenerates the
          // whole file instead of making a targeted edit).
          const isWrite = call.function.name === 'create_file' || call.function.name === 'edit_file';
          const writePath = isWrite ? writtenPathOf(call.function.name, call.function.arguments) : undefined;
          const oldText = writePath ? await this._readWorkspaceFile(writePath) : '';

          // Some tools are handled by the provider (they need UI or the client),
          // the rest by executeTool. MCP tools go over the MCP transport.
          // Checkpoint capture now happens INSIDE the mutating tools themselves
          // (via recordPreMutation → the recorder registered at turn start), so
          // the loop no longer needs to know which tool names mutate files.
          const isWriteTool = call.function.name === 'create_file' ||
            call.function.name === 'edit_file' || call.function.name === 'move_file';
          const dupKey = isWriteTool ? `${call.function.name}:${call.function.arguments}` : '';
          let output: string;
          // Deterministic tool-call budget (covers MCP too — this is the one
          // dispatch point every tool passes through). A tripped budget ends
          // the turn; the model cannot negotiate with the runtime.
          const budgetVerdict = gateToolCall();
          if (!budgetVerdict.allowed) {
            output = policyMessage(budgetVerdict);
            budgetStop = budgetVerdict.reason || 'change budget exceeded';
          } else if (dupKey && doneWrites.has(dupKey)) {
            output = `Duplicate call SKIPPED: you already made this exact ${call.function.name} call ` +
              `and it succeeded ("${doneWrites.get(dupKey)}"). The change is already applied — never ` +
              `repeat a tool call that succeeded. Continue with the NEXT step.`;
            // The repeated arguments are pure context waste — stub them.
            try {
              const a = JSON.parse(call.function.arguments || '{}');
              call.function.arguments = JSON.stringify({
                path: a.path ?? a.source,
                note: 'duplicate of an earlier successful call — skipped, arguments omitted',
              });
            } catch { /* ignore */ }
          } else if (call.function.name === 'update_todos') {
            output = this._handleUpdateTodos(call.function.arguments);
          } else if (call.function.name === 'run_subagent') {
            output = await this._runSubagent(call.function.arguments);
          } else if (call.function.name === 'run_subagents') {
            output = await this._runSubagents(call.function.arguments);
          } else if (call.function.name === 'verify_visual') {
            output = await this._verifyVisual(call.function.arguments);
          } else if (isMcpTool(call.function.name)) {
            output = await callMcpTool(call.function.name, call.function.arguments);
          } else {
            output = await executeTool(call.function.name, call.function.arguments);
          }
          // A rejected oversized call (whole-file edit/overwrite) carries huge,
          // useless arguments. Stub them so they don't bloat every subsequent
          // request's context (the assistant message holds the same reference).
          if (output.startsWith('Search block too large') ||
              output.includes('Do NOT regenerate the whole file')) {
            try {
              const a = JSON.parse(call.function.arguments || '{}');
              call.function.arguments = JSON.stringify({
                path: a.path,
                note: 'oversized call was REJECTED — arguments omitted; make small targeted edits instead',
              });
            } catch { /* ignore */ }
          }

          if (dupKey && /^(Created|Edited|Moved)\b/.test(output)) {
            doneWrites.set(dupKey, output.split('\n')[0].slice(0, 120));
          }
          // Metrics: count this tool call and classify write outcomes.
          if (this._turnMetrics) {
            const m = this._turnMetrics;
            m.toolCalls++;
            m.toolCallsByName[call.function.name] = (m.toolCallsByName[call.function.name] || 0) + 1;
            if (isMutatingTool(call.function.name)) {
              m.editAttempts++;
              if (isWriteFailure(output)) { m.editFailures++; }
            }
            // The user vetoed an action → a correction, not a routine approval.
            if (isUserDecline(output)) { m.interventions.correction++; }
            // Count build/test the MODEL ran itself, so metricsReport can show
            // when it duplicates the verify gate's work (see verifyRuns).
            if (call.function.name === 'run_command') {
              try {
                if (isVerifyLikeCommand(JSON.parse(call.function.arguments || '{}').command || '')) {
                  m.modelVerifyCommands++;
                }
              } catch { /* ignore */ }
            }
          }
          // Evidence log: record behaviourally-relevant actions (commands run and
          // their outcome, visual checks, diagnostics) so the requirement review
          // can judge each requirement against what ACTUALLY happened this turn —
          // not the model's assertion. Reset at round 0, accumulates across rounds.
          this._recordEvidence(call.function.name, call.function.arguments, output);
          // Chronological run record (labels + outcome shape, not payloads).
          this._runLog?.append('tool', {
            name: call.function.name,
            label: label.slice(0, 160),
            ok: !isWriteFailure(output),
            outputChars: output.length,
          });
          const written = writtenPathOf(call.function.name, call.function.arguments);
          if (written) {
            writtenPaths.add(written);
            if (/^(Created|Edited|Moved)\b/.test(output)) {
              this._turnChangedFiles.add(written.replace(/\\/g, '/'));
              writeEvents++;
              // Real progress since the last nudge — refill the nudge budget.
              // The cap only exists to stop nudge LOOPS (4 pushes in a row with
              // zero results); a long build that writes files between nudges
              // must never exhaust it and silently abandon the plan mid-way.
              nudges = 0;
              this._advanceTodosForWrite(written);
            }
          }
          // Files produced via run_command (e.g. a node script writing PNGs)
          // never go through the write tools — advance todos for filenames
          // mentioned in a successful command or its output.
          if (call.function.name === 'run_command' && /Exit code: 0/.test(output)) {
            const src = call.function.arguments + '\n' + output.slice(0, 4000);
            const names = src.match(/[\w./\\-]+\.(?:png|jpe?g|gif|webp|svg|html?|css|js|mjs|json|py|txt|md)\b/gi) || [];
            // Generator output often names bare files ("✓ paddle.png") while
            // the command cd'd into a folder — try that folder as a prefix too.
            const cdDir = (call.function.arguments.match(/\bcd\s+([\w./\\-]+)/i) || [])[1];
            const seenNames = new Set<string>();
            for (const n of names.slice(0, 20)) {
              const baseName = (n.split(/[\\/]/).pop() || '').toLowerCase();
              if (!baseName || seenNames.has(baseName)) { continue; }
              seenNames.add(baseName);
              this._advanceTodosForWrite(n);
              if (/\.(png|jpe?g|gif|webp)$/i.test(n)) {
                commandImages.add(n.replace(/\\/g, '/'));
                if (cdDir) { commandImages.add(`${cdDir}/${n}`.replace(/\\/g, '/')); }
              }
            }
          }
          // A screenshot_url capture produces a PNG outside the write tools —
          // preview it like a generated image (preview-only, not the verify gate).
          if (call.function.name === 'screenshot_url') {
            const m = output.match(/^Saved screenshot to "([^"]+)"/);
            if (m) { commandImages.add(m[1].replace(/\\/g, '/')); }
          }
          // Show a real old→new diff of what the write actually changed.
          if (writePath && /^(Created|Edited)\b/.test(output)) {
            const newText = await this._readWorkspaceFile(writePath);
            const hunks = computeLineDiff(oldText, newText);
            if (hunks.length > 0) {
              this._postMessage({ type: 'toolDiff', path: writePath, hunks });
            }
          }
          const toolMsg: ChatMessage = {
            role: 'tool',
            tool_call_id: call.id,
            content: output,
          };
          messages.push(toolMsg);
          turnMessages.push(toolMsg);
        }

        // The change budget tripped: stop the turn NOW, visibly. This is a
        // policy stop, not a failure of the model.
        if (budgetStop) {
          this._postMessage({
            type: 'toolActivity',
            label: `⛔ CHANGE_BUDGET_EXCEEDED — ${budgetStop}`,
          });
          this._postMessage({
            type: 'notice', level: 'warning',
            text: `CodeFlare stopped this turn: ${budgetStop}. Review what was done so far, then continue explicitly if wanted.`,
          });
          this._runLog?.append('note', { note: `budget stop: ${budgetStop}` });
          log(`Policy: turn stopped — ${budgetStop}`);
          break;
        }

        // The model dove straight into a big task without creating a plan —
        // remind it once. Everything downstream (progress ticks in the plan
        // pill, continue-nudges, budget extension) works best against a todo
        // list, and users expect to see one for multi-step work.
        if (step === 0 && round === 0 && !planReminded &&
            this._planCallsThisTurn === 0 && this._todos.length === 0 &&
            userMessage.length > 400) {
          planReminded = true;
          messages.push({
            role: 'user',
            content: 'REMINDER (automated, not user feedback): this is a multi-step task — call ' +
              'update_todos NOW with the full hierarchical plan (name the target file in each step), ' +
              'then continue executing. The checklist auto-advances as you work.',
          });
        }

        // A fresh plan pauses the turn: the user reviews it before execution.
        if (this._planAwaitingReview) {
          this._planAwaitingReview = false;
          pausedForPlan = true;
          break;
        }

        // Narration before a tool call isn't the final answer — reset so the
        // last (tool-free) step is what we post-process and store.
        fullResponse = '';
      }

      // Agent ended without a final answer — give the user an honest note.
      // Check THIS turn's tool messages (history also contains tool messages,
      // which made an aborted empty turn show this note incorrectly), and stay
      // quiet when the user pressed Stop.
      if (!fullResponse && !pausedForPlan && !this._stopRequested &&
          turnMessages.some(m => m.role === 'tool')) {
        fullResponse = stepsUsed >= budget
          ? `_(Reached the ${stepsUsed}-step limit without finishing. The budget only auto-extends while new files are being written — say "continue" to resume, or increase \`codeflare.agentMaxSteps\`.)_`
          : `_(The model stopped after ${stepsUsed} step(s) without a final summary — the task may be incomplete. Say "continue" to let it pick up where it left off.)_`;
      }

      let finalResponse = fullResponse;

      // Legacy single-file apply flow (SEARCH/REPLACE against the ACTIVE editor,
      // with a blocking diff modal). In agent mode the model edits via tools and
      // the final message is just a summary — running this misfires on summary
      // code snippets and locks on the modal, so skip it. SEARCH/REPLACE blocks
      // still render with clickable "Apply" buttons in the chat.
      if (!config.agentMode) {
        if (fullResponse && !hasEditBlocks(fullResponse)) {
          const editor = resolveActiveEditor();
          if (editor && editor.document.uri.scheme === 'file') {
            const converted = this._postProcessCodeDump(fullResponse, editor.document.getText());
            if (converted) { finalResponse = converted; }
          }
        }
      }

      // Never end a turn completely silent. If the model produced no final text
      // AND no tool work this round, the user would just see the spinner vanish
      // ("plugin stopped"). Surface a clear, actionable notice instead. Excludes
      // the plan-review pause (an empty answer there is expected).
      if (!finalResponse && turnMessages.length === 0 && !pausedForPlan &&
          !this._stopRequested && !hadError) {
        // Empty completions usually mean the inference SERVER is degraded, not
        // the prompt (confirmed: instant 0-char answers, fixed by a server
        // restart). Probe it live so the advice matches the actual cause.
        const healthy = await this._client.checkHealth().catch(() => false);
        finalResponse = healthy
          ? 'The model returned an empty response and took no action. The server answers its ' +
            'health check, but repeated instant empty completions usually mean the inference ' +
            'server is degraded — restarting it is the proven fix. Otherwise try resending, ' +
            'rephrasing more specifically, or starting a new chat to reset the context.'
          : `The model returned an empty response, and the server at ${config.endpoint} is NOT ` +
            'responding to its health check — restart the inference server, then resend your message.';
        log(`Empty turn — surfaced fallback notice (server health: ${healthy ? 'ok' : 'DOWN'})`);
      }

      // Send streamEnd with optional converted content for the webview
      this._postMessage({
        type: 'streamEnd',
        ...(finalResponse !== fullResponse ? { content: finalResponse } : {}),
      });

      // Persist this turn's tool exchanges so the model keeps the files/results
      // it already saw in context (no re-reading next turn). Skipped if the chat
      // was cleared mid-turn (epoch changed) — don't resurrect a cleared thread.
      if (this._historyEpoch === startEpoch) {
        this._history.push(...turnMessages);
        turnPersisted = true;

        if (finalResponse) {
          this._history.push({ role: 'assistant', content: finalResponse });
          this._transcript.push({ role: 'assistant', text: finalResponse });
          if (!config.agentMode) {
            this._autoApplyResponse(finalResponse);
          }
        }
        this._persist();
      }
      log(`Response complete (${finalResponse.length} chars, +${turnMessages.length} tool msgs)`);

      // Paused for plan review: show the approval bar and end the turn here.
      if (pausedForPlan) {
        // The user is being asked to approve a plan — a routine gate, not a
        // sign the agent went wrong (kept apart from 'correction').
        if (this._turnMetrics) { this._turnMetrics.interventions.approval++; }
        this._postMessage({ type: 'planReview' });
        log('Turn paused for plan review');
        return;
      }

      // Clarification: the agent finished a turn without acting (no tool calls,
      // no files changed) and ended by asking the user a question — it needed
      // information rather than being corrected. Heuristic, main frame only.
      if (round === 0 && this._turnMetrics && this._turnChangedFiles.size === 0 &&
          this._turnMetrics.toolCalls === 0 && /\?\s*$/.test(finalResponse.trim())) {
        this._turnMetrics.interventions.clarification++;
      }

      // Preview any image files the turn produced (written by tools, generated
      // by successful commands, or referenced in the final answer).
      const producedImages = await this._showGeneratedImages(
        new Set([...writtenPaths, ...commandImages]), finalResponse);

      // Image QC: pixel-check produced PNGs; broken ones trigger a fix round
      // (with the images attached — the endpoint is vision-capable).
      let qcRan = false;
      if (!this._stopRequested) {
        qcRan = await this._runImageQc(producedImages, round);
      }

      // Verification: after the agent wrote files, (1) check for NEW errors —
      // including regressions in files it didn't touch — and (2) run the verify
      // command (typecheck/tests). Either failure feeds back for a bounded fix
      // round. Skipped when the user pressed Stop or the image-QC round already
      // recursed. The verify command only runs when diagnostics were clean, so
      // the model isn't handed two failure reports at once.
      if (!this._stopRequested && !qcRan) {
        // Include files changed via apply_patch/rename/delete (tracked by the
        // checkpoint recorder), not just the create/edit/move paths this round.
        const changed = new Set<string>([...writtenPaths, ...this._turnMutatedPaths]);
        const diagRan = await this._runDiagnosticsRound(changed, round);
        let verifyRan = false;
        if (!diagRan && !this._stopRequested) {
          verifyRan = await this._runVerifyGate(changed, round);
        }
        // Project metric gate (verification.json): baseline vs candidate with
        // configured regression thresholds. Runs once syntax/build are clean.
        if (!diagRan && !verifyRan && !this._stopRequested) {
          verifyRan = await this._runMetricsGate(round);
        }
        // Final gate: once diagnostics and verify are clean, the agent reviews
        // its own diff against the request (correctness, scope, minimality).
        if (!diagRan && !verifyRan && !this._stopRequested) {
          await this._runDiffReview(round);
        }
      }
    } catch (err: any) {
      // Keep any tool exchanges already made this turn (files are on disk); a
      // later "continue" must see them so it doesn't re-run the same edits.
      persistTurnMessages();
      this._postMessage({ type: 'streamError', error: err.message });
      log(`Unexpected error: ${err.message}`);
    } finally {
      // Instrumentation is scaffolding — never let it survive the turn that
      // placed it. Only the OUTERMOST frame strips (diagnostics/QC rounds
      // recurse with round+1 and the agent may still be measuring), and a
      // plan-review pause is not the end of a turn.
      if (round === 0 && !pausedForPlan) {
        await this._stripTurnProbes();
      }
    }
  }

  /**
   * Remove every probe this turn placed. Runs on the normal path, on an error,
   * and after Stop — the one guarantee that matters is that the user's code is
   * never left instrumented.
   */
  private async _stripTurnProbes(): Promise<void> {
    if (!getConfig().probeAutoStrip || !hasActiveProbes()) { return; }
    try {
      const removed = await stripAllProbes();
      if (removed > 0) {
        log(`Auto-stripped ${removed} probe(s) at end of turn`);
        vscode.window.setStatusBarMessage(`CodeFlare: removed ${removed} probe(s)`, 4000);
      }
    } catch (err: any) {
      log(`Probe auto-strip failed: ${err.message}`);
    }
  }

  /**
   * Show image files the turn produced. Candidates are files the agent wrote
   * plus image filenames it mentioned in its answer (covers images generated
   * via run_command, e.g. a Python script). Only files that exist and are a
   * reasonable size are previewed.
   */
  private async _showGeneratedImages(
    writtenPaths: Set<string>,
    finalResponse: string
  ): Promise<{ rel: string; url: string; bytes: Uint8Array }[]> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) { return []; }

    const candidates = new Set<string>();
    for (const p of writtenPaths) { if (IMAGE_EXT.test(p)) { candidates.add(p); } }
    for (const p of imagePathsInText(finalResponse)) { candidates.add(p); }
    if (candidates.size === 0) { return []; }

    const MAX_BYTES = 5 * 1024 * 1024;
    const images: { rel: string; url: string; bytes: Uint8Array }[] = [];
    const seen = new Set<string>();

    for (const rel of candidates) {
      const clean = rel.replace(/\\/g, '/').replace(/^\.\//, '').trim();
      // Skip absolute paths or anything escaping the workspace.
      if (!clean || clean.startsWith('/') || /^[a-zA-Z]:/.test(clean) || clean.includes('..')) { continue; }
      const uri = vscode.Uri.joinPath(root, clean);
      if (seen.has(uri.toString())) { continue; }
      seen.add(uri.toString());
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type !== vscode.FileType.File || stat.size > MAX_BYTES) { continue; }
        const bytes = await vscode.workspace.fs.readFile(uri);
        const b64 = Buffer.from(bytes).toString('base64');
        images.push({ rel: clean, url: `data:${imageMime(clean)};base64,${b64}`, bytes });
      } catch {
        // Not a real file (e.g. a filename mentioned but not created) — skip.
      }
    }

    if (images.length > 0) {
      // Use the workspace-relative path as the name: it shows on hover and in
      // the copied chat log, where the image itself can't be embedded.
      this._postMessage({
        type: 'showImages',
        images: images.map(im => ({ url: im.url, name: im.rel })),
      });
      this._transcript.push({
        role: 'assistant',
        images: images.map(im => ({ url: im.url, name: im.rel })),
      });
      this._persist();
      log(`Previewing ${images.length} generated image(s)`);
    }
    return images;
  }

  /**
   * Automatic image QC: pixel-check the PNGs this turn produced. The model is
   * text-only, so it can't SEE its sprites — but "the visible pixels are all
   * black" is text feedback it can act on. Broken images trigger a fix round
   * (like the diagnostics loop); the images are also attached as image parts so
   * a vision-capable endpoint can inspect them for real.
   */
  private async _runImageQc(
    images: { rel: string; url: string; bytes: Uint8Array }[],
    round: number
  ): Promise<boolean> {
    const config = getConfig();
    if (!config.imageQC || images.length === 0) { return false; }
    if (round >= config.diagnosticsMaxRounds) { return false; }

    const problems: string[] = [];
    const brokenUrls: string[] = [];
    let analyzed = 0;
    for (const im of images) {
      if (!/\.png$/i.test(im.rel)) { continue; }
      const s = analyzePng(im.bytes);
      if (!s || !s.analyzed) { continue; }
      analyzed++;
      const desc = `${im.rel} — ${s.width}x${s.height}, ${s.transparentPct}% transparent, ` +
        `${s.blackPct}% of visible pixels near-black, ~${s.distinctColors} color group(s)`;
      log(`Image QC: ${desc}`);
      if (looksBroken(s)) {
        // Flag each unchanged image ONCE — re-flagging the same pixels every
        // round makes the model re-litigate an intentional design repeatedly.
        const sig = `${s.width}x${s.height}:${s.transparentPct}:${s.blackPct}`;
        if (this._qcReported.get(im.rel) === sig) {
          log(`Image QC: ${im.rel} already reported this turn — skipping re-flag`);
          continue;
        }
        this._qcReported.set(im.rel, sig);
        problems.push(desc);
        brokenUrls.push(im.url);
      }
    }
    if (problems.length === 0) {
      if (analyzed > 0) { this._turnGates.imageQc = 'clean'; }
      return false;
    }
    this._turnGates.imageQc = 'failed';
    this._turnEvidence.push(makeEvidence('STATIC_ANALYSIS', 'gate:imageQc',
      `image QC → ${problems.length} of ${analyzed} generated image(s) look blank/black`, 'fail', 'post-edit'));

    this._postMessage({
      type: 'toolActivity',
      label: `image QC: ${problems.length} image(s) look blank/black — fixing`,
    });

    const report =
      'AUTOMATIC IMAGE QC — a pixel check of the image(s) you just produced found problems:\n\n' +
      problems.join('\n') +
      '\n\nThese images are effectively blank (black, empty or one flat color). The broken images ' +
      'are ATTACHED to this message — look at them. For a GENERATED sprite: common causes are ' +
      'drawing with alpha 0, filling before setting the color, wrong coordinate ranges, or saving ' +
      'before drawing — re-read your generation script, fix it, and REGENERATE with run_command. ' +
      'For a page SCREENSHOT: the page rendered blank — check for a JavaScript error at load, ' +
      'wrong script/css paths (404), or the server serving the wrong folder; fix the cause and ' +
      'take a NEW screenshot. Then confirm what you changed. ' +
      'EXCEPTION: if an image is intentionally like this per the user\'s explicit request, do NOT ' +
      'change it — just say so briefly.';

    // Store the QC turn with the images attached (useful on vision endpoints).
    this._history.push({
      role: 'user',
      content: [
        { type: 'text', text: report },
        ...brokenUrls.map(u => ({ type: 'image_url' as const, image_url: { url: u } })),
      ],
    });
    const context = gatherContext();
    const systemPrompt = buildSystemPrompt(context);
    await this._streamResponse(systemPrompt, report, context, brokenUrls, round + 1);
    return true;
  }

  /** Record a behaviourally-relevant tool action for the requirement review's evidence. */
  private _recordEvidence(name: string, rawArgs: string, output: string): void {
    if (this._turnEvidence.length >= 40) { return; }
    // Phase = ORDER relative to the first file change this turn, so an ordering
    // requirement ("reproduce BEFORE the fix") can be checked: an action logged
    // while nothing was edited yet is pre-edit, otherwise post-edit.
    const phase = this._turnMutatedPaths.size === 0 ? 'pre-edit' as const : 'post-edit' as const;
    const item = classifyToolEvidence(name, rawArgs, output, phase);
    if (!item) { return; }          // reads/edits aren't behavioural evidence (the diff covers edits)
    this._turnEvidence.push(item);
    this._runLog?.append('evidence', {
      type: item.type, result: item.result, phase: item.phase,
      description: item.description.slice(0, 200),
    });
  }

  /** True when the request explicitly asks to verify ACTUAL behaviour (not just syntax/diagnostics/build). */
  private _requestWantsBehaviorVerification(): boolean {
    const r = this._turnRequest || '';
    return [
      /actual behavio(u)?r/i,
      /\bverif\w*\b[^.]*\bbehavio(u)?r/i,
      /\bbehavio(u)?r\b[^.]*\b(verif|test|check|confirm)/i,
      /not just\b[^.]*\b(syntax|diagnostic|build|compil)/i,
      /test the (actual|real)\b/i,
      /\b(e2e|end[- ]?to[- ]?end)\b/i,
      /verif\w*[^.]*\bit works\b/i,
    ].some(re => re.test(r));
  }

  /** True when the request asks to REPRODUCE the bug before fixing (an ordering requirement). */
  private _requestWantsReproduceFirst(): boolean {
    const r = this._turnRequest || '';
    return /reproduc\w*[\s\S]{0,40}\b(before|prior|first)\b/i.test(r) ||
      /\b(before|first)\b[\s\S]{0,30}\breproduc/i.test(r) ||
      /reproduce the (bug|issue|failure|problem|error|crash)\b/i.test(r);
  }

  /** True when the request forbids unrelated/out-of-scope changes. */
  private _requestForbidsUnrelatedChanges(): boolean {
    const r = this._turnRequest || '';
    return /\bunrelated\b/i.test(r) || /\bdo ?n['’o]?t\s+(change|modify|touch|edit)\b/i.test(r);
  }

  /** A compact diff of everything this turn changed, from the checkpoint pre-state. */
  private async _buildTurnDiff(): Promise<string> {
    const cp = this._activeCheckpoint;
    if (!cp || cp.files.size === 0) { return ''; }
    const CAP = 8000;
    const parts: string[] = [];
    let total = 0;
    for (const [rel, pre] of cp.files) {
      const cur = await this._readWorkspaceFile(rel);
      const preText = pre ?? '';
      if (preText === cur) { continue; }
      const tag = pre === null ? ' (new file)' : (cur === '' ? ' (deleted)' : '');
      const hunks = computeLineDiff(preText, cur, 120);
      const body = hunks.map(h => (h.t === '.' ? `  ${h.line}` : `${h.t}${h.line}`)).join('\n');
      const section = `### ${rel}${tag}\n${body}`;
      if (total + section.length > CAP) { parts.push('… (diff truncated)'); break; }
      parts.push(section);
      total += section.length;
    }
    return parts.join('\n\n');
  }

  /**
   * Final REQUIREMENT review — separate from the code verification the verify
   * gate already did. With diagnostics and the build green, the agent checks its
   * OWN diff against the ORIGINAL request one requirement at a time: for each
   * thing the user asked for, does the diff actually satisfy what it MEANS (not a
   * convenient reinterpretation)? "Self-review passed" only when every
   * requirement is met with evidence. Unmet ones are fed back for a bounded fix
   * round; when the fix rounds run out, the still-unmet requirements are
   * surfaced to the USER instead of silently declaring done. Returns true if it
   * recursed into a fix round.
   */
  private async _runDiffReview(round: number): Promise<boolean> {
    const config = getConfig();
    if (!config.diffReview || this._turnMutatedPaths.size === 0) { return false; }
    if (!this._turnRequest.trim()) { return false; }
    // At the terminal round we can no longer recurse to fix — but we still RUN
    // the check, to report honestly rather than skip silently.
    const terminal = round >= config.diagnosticsMaxRounds;

    const diff = await this._buildTurnDiff();
    if (!diff) { return false; }

    // Evidence: what the turn ACTUALLY ran (commands + outcome, visual checks,
    // diagnostics). The reviewer maps each requirement to this, not to the
    // model's say-so — a "verify the behaviour" requirement can only be MET if
    // the evidence shows a real run/test/screenshot exercised it.
    const evidence = this._turnEvidence.length
      ? this._turnEvidence.map(e => `- ${renderEvidenceLine(e)}`).join('\n')
      : '(no commands, tests, or visual checks were run this turn — only file edits and/or diagnostics)';
    const behavioralActions = this._turnEvidence.filter(isBehavioral).length;

    this._postMessage({ type: 'toolActivity', label: 'reviewing against requirements…' });
    const system =
      'You are verifying YOUR OWN change against the user\'s request BEFORE declaring the task done. ' +
      'Diagnostics and the build/verify step already passed — do NOT re-check syntax or compilation. ' +
      'This is REQUIREMENT verification, which is SEPARATE from code verification: for EACH distinct ' +
      'requirement the user stated, decide whether it is satisfied by EVIDENCE — the diff AND the list ' +
      'of actions actually taken this turn — not by a convenient reinterpretation or an assertion.\n' +
      'Two failure modes to catch:\n' +
      '1) a requirement that names a behaviour, implemented as something subtly different ' +
      '("remove items that no longer EXIST" done as "remove CORRUPTED items" — NOT MET);\n' +
      '2) a requirement to VERIFY/TEST that it actually works, when the evidence shows only edits, a ' +
      'build, or diagnostics — NOT an actual run/test/screenshot that exercised the behaviour. ' +
      'Editor diagnostics, a typecheck or a successful build do NOT prove behaviour → that is UNVERIFIED.\n' +
      'ORDER matters: each evidence line is tagged [pre-edit] or [post-edit]. If a requirement demands ' +
      'an action BEFORE another (e.g. "reproduce the bug BEFORE fixing"), it is only [MET] when the ' +
      'evidence shows that action [pre-edit]; a repro that ran only [post-edit] does not satisfy it. ' +
      'A dependency install shown in the evidence changes package.json/lockfiles that are NOT in the ' +
      'diff — count it against "do not change unrelated code" unless the task required it.\n\n' +
      'List EVERY requirement (split compound sentences), each on its own line as:\n' +
      '- [MET] <requirement> — <concrete evidence: the diff line(s) and/or the action that proves it>\n' +
      '- [PARTIAL] <requirement> — <what is still missing>\n' +
      '- [NOT MET] <requirement> — <why the change does not satisfy what it means>\n' +
      '- [UNVERIFIED] <requirement> — <it may be implemented, but no action actually exercised/verified it>\n' +
      '- [UNCERTAIN] <requirement> — <what cannot be confirmed at all>\n' +
      'Also add rows for the implicit requirements: no unintended/out-of-scope changes; tests added or ' +
      'updated if the project has tests; existing behaviour preserved.\n\n' +
      'End with EXACTLY one line:\n' +
      'VERDICT: OK        — only if EVERY row is [MET]\n' +
      'VERDICT: ISSUES    — if any row is [PARTIAL], [NOT MET], [UNVERIFIED] or [UNCERTAIN]\n' +
      'Be strict and evidence-based; do not invent requirements the user never asked for.';
    const user = `USER REQUEST:\n${this._turnRequest.slice(0, 4000)}\n\n` +
      `ACTIONS ACTUALLY TAKEN THIS TURN (evidence — this is what really ran, not what was claimed):\n${evidence}\n\n` +
      `YOUR CHANGES THIS TURN (diff):\n${diff}`;

    let verdict = '';
    try {
      verdict = await this._client.complete(
        [{ role: 'system', content: system }, { role: 'user', content: user }], 1000);
    } catch (err: any) {
      log(`Requirement review call failed: ${err.message}`);
      return false;
    }
    const clean = verdict.trim();
    // Unmet = any requirement row not tagged [MET].
    const unmet = (clean.match(/^\s*[-*]\s*\[\s*(?:partial|not[\s-]?met|unverified|uncertain)\s*\][^\n]*/gim) || [])
      .map(s => s.replace(/^\s*[-*]\s*/, '').trim());
    // Deterministic backstop: the request explicitly demanded behavioural
    // verification, but the turn ran ZERO behavioural actions (no command, no
    // verify_visual — only edits/diagnostics). That is UNVERIFIED no matter what
    // the model claimed, so it can never rubber-stamp "verify it works" with just
    // a get_diagnostics call.
    if (this._requestWantsBehaviorVerification() && behavioralActions === 0 &&
        !unmet.some(u => /unverified/i.test(u))) {
      unmet.push('[UNVERIFIED] Verify the ACTUAL behaviour — no run/test/screenshot exercised the ' +
        'change this turn (only edits/diagnostics). Actually run it and confirm the result.');
    }
    // Ordering backstop: the request asked to REPRODUCE the bug before fixing,
    // but no run/test ran BEFORE the first edit (every behavioural action is
    // [post-edit]) — the fix went in first. Flag it no matter what the model said.
    const reproducedFirst = this._turnEvidence.some(e => e.phase === 'pre-edit' && isBehavioral(e));
    if (this._requestWantsReproduceFirst() && !reproducedFirst && !unmet.some(u => /reproduc/i.test(u))) {
      unmet.push('[NOT MET] Reproduce the bug BEFORE the fix — no run/test exercised the bug before the ' +
        'first edit this turn (the fix was applied first). Demonstrate the failure actually reproduces ' +
        'without your fix (e.g. show the regression test FAILS on the unfixed behaviour), then keep the fix.');
    }
    // Unrelated-change backstop: the request forbade unrelated changes, but a
    // dependency was installed (touches package.json/lockfile outside the diff).
    const installs = this._turnEvidence.filter(e => e.tags?.includes('dependency-install')).length;
    if (this._requestForbidsUnrelatedChanges() && installs > 0 && !unmet.some(u => /depend|install/i.test(u))) {
      unmet.push(`[NOT MET] Do not change unrelated code — a dependency was installed this turn ` +
        `(${installs} install command(s)), which modifies package.json/lockfile outside the diff. If it ` +
        `was only for a throwaway test, revert it (uninstall and restore the manifest); otherwise state ` +
        `why the task requires it.`);
    }
    const explicitOk = /verdict:\s*ok\b/i.test(clean);
    const explicitIssues = /verdict:\s*issues\b/i.test(clean);
    const hasIssues = unmet.length > 0 || (explicitIssues && !explicitOk);

    if (!hasIssues) {
      this._turnGates.diffReview = 'ok';
      this._postMessage({ type: 'toolActivity', label: '✓ requirements met — self-review passed' });
      log('Requirement review: all requirements met');
      return false;
    }

    this._turnGates.diffReview = 'issues';
    this._runLog?.append('gate', { gate: 'diffReview', result: 'issues', unmet: unmet.length });
    if (this._turnMetrics) { this._turnMetrics.reviewFindings += unmet.length || 1; }
    // Body of unmet requirements (fall back to the matrix minus the verdict line).
    const body = unmet.length
      ? unmet.map(u => `- ${u}`).join('\n')
      : (clean.replace(/^\s*verdict:.*$/im, '').trim() || clean);

    if (terminal) {
      // Out of automatic fix rounds — be honest instead of passing silently.
      this._postMessage({ type: 'toolActivity', label: `⚠ ${unmet.length || 'some'} requirement(s) may be unmet` });
      this._postMessage({
        type: 'notice', level: 'warning',
        text: `Self-review (requirements): the automatic fix rounds are used up, but these ` +
          `requirement(s) from your request may NOT be fully met — please check:\n${body}`,
      });
      log(`Requirement review: ${unmet.length} unmet at terminal round — surfaced to user`);
      return false;
    }

    this._postMessage({ type: 'toolActivity', label: 'self-review: requirements unmet — fixing' });
    log(`Requirement review: ${unmet.length} unmet → fix round ${round + 1}`);
    const unverifiedNote = unmet.some(u => /unverified/i.test(u))
      ? `\n\nFor any [UNVERIFIED] item you must actually EXERCISE the behaviour and report the result — ` +
        `run it, test it, or screenshot it with verify_visual (for a web page: start the server and ` +
        `use playwright + verify_visual). Editor diagnostics or a build do NOT satisfy a "verify the ` +
        `behaviour" requirement. Do not declare done until you have shown it works.`
      : '';
    const feedback =
      `SELF-REVIEW (automated requirement check, not user feedback): comparing your change to the ` +
      `ORIGINAL request against what actually ran this turn, the requirement(s) below are not fully ` +
      `met. Address them, then finish. If one is in fact satisfied, cite the concrete evidence instead ` +
      `of changing code — do NOT reinterpret a requirement to make it pass.\n\n${body}${unverifiedNote}`;
    this._history.push({ role: 'user', content: feedback });
    const context = gatherContext();
    const systemPrompt = buildSystemPrompt(context);
    await this._streamResponse(systemPrompt, feedback, context, undefined, round + 1);
    return true;
  }

  /**
   * After a turn that wrote files, gather NEW editor errors — including
   * regressions in files the agent never opened — and, if there are any, ask
   * the agent to fix them (bounded rounds). Returns true if it recursed into a
   * fix round (so the caller skips the verify command this round).
   */
  private async _runDiagnosticsRound(writtenPaths: Set<string>, round: number): Promise<boolean> {
    const config = getConfig();
    if (!config.diagnosticsLoop || writtenPaths.size === 0) { return false; }
    if (round >= config.diagnosticsMaxRounds) {
      log(`Diagnostics loop: reached max ${config.diagnosticsMaxRounds} round(s)`);
      return false;
    }

    // Only wait on diagnostics for files a language server actually analyzes —
    // skip images/assets/plain files so a fresh directory doesn't stall ~2s.
    const DIAGNOSABLE = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|py|go|rs|java|c|h|cpp|hpp|cc|hh|cs|rb|php|swift|kt|scala|vue|svelte|css|scss|less|html|htm)$/i;
    const codePaths = [...writtenPaths].filter(p => DIAGNOSABLE.test(p));
    if (codePaths.length === 0) {
      log('Diagnostics loop: no source files written — skipping');
      return false;
    }

    // NEW errors only (vs the turn-start baseline), across the whole workspace,
    // so a change that breaks an untouched file is caught as a regression.
    const report = await collectNewErrors(codePaths, this._errorBaseline);
    if (report.errorCount === 0) {
      // A real check ran and found nothing new: verification demonstrated clean.
      // (A failing diagnostics round recurses before verify runs, so within one
      // round we never overwrite a genuine 'failed' — latest check wins.)
      if (this._turnMetrics) { this._turnMetrics.verified = 'clean'; }
      this._turnGates.diagnostics = 'clean';
      this._turnEvidence.push(makeEvidence('DIAGNOSTIC', 'gate:diagnostics',
        `diagnostics gate → no new errors after writing ${writtenPaths.size} file(s)`, 'pass', 'post-edit'));
      log(`Diagnostics loop: no new errors after writing ${writtenPaths.size} file(s)`);
      return false;
    }
    if (this._turnMetrics) { this._turnMetrics.diagnosticErrors += report.errorCount; this._turnMetrics.verified = 'failed'; }
    this._turnGates.diagnostics = 'failed';
    this._turnEvidence.push(makeEvidence('DIAGNOSTIC', 'gate:diagnostics',
      `diagnostics gate → ${report.errorCount} new error(s)`, 'fail', 'post-edit'));
    this._runLog?.append('gate', { gate: 'diagnostics', result: 'failed', errors: report.errorCount });

    this._postMessage({
      type: 'toolActivity',
      label: `problems: ${report.errorCount} new error(s) — fixing`,
    });
    log(`Diagnostics loop: ${report.errorCount} new error(s) → fix round ${round + 1}`);

    const feedback =
      `Your changes introduced the errors below (some may be in files you did not edit — ` +
      `a regression from a change you made). Fix them by editing the affected files ` +
      `(read them first if needed).\n\n${report.text}`;

    // Push as a user turn so the model treats it as the next instruction, then
    // re-run the agent. The UI shows only the compact "problems" chip above.
    this._history.push({ role: 'user', content: feedback });
    const context = gatherContext();
    const systemPrompt = buildSystemPrompt(context);
    await this._streamResponse(systemPrompt, feedback, context, undefined, round + 1);
    return true;
  }

  /**
   * Verify gate: after edits settle, run the project's verify command
   * (typecheck/tests — configured or auto-detected) and, if it fails, feed the
   * output back for a bounded fix round. This is what turns "it compiles" into
   * "it type-checks and the tests pass" before the agent declares done.
   */
  /**
   * True when a failed verify command failed because its EXECUTABLE is missing
   * (not because the code is broken) — so the gate can skip it instead of
   * looping on an unfixable "install the toolchain" error. Matched narrowly: the
   * shell must report a not-found/not-recognized error AND name the command's
   * own executable, so a real "cannot find module X" code error still counts.
   */
  private _isMissingToolFailure(command: string, output: string): boolean {
    if (!/not recognized|command not found|no such file or directory/i.test(output)) { return false; }
    const exe = (command.trim().split(/\s+/)[0] || '').replace(/^[.\\/]+/, '').split(/[\\/]/).pop() || '';
    if (!exe) { return false; }
    return output.toLowerCase().includes(exe.toLowerCase());
  }

  /** Load .codeflare/verification.json (surface a malformed file, never mask it). */
  private async _loadVerificationConfig(): Promise<void> {
    this._verificationConfig = undefined;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) { return; }
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(root, '.codeflare', 'verification.json'));
      text = new TextDecoder().decode(bytes);
    } catch { return; }   // no config — normal
    const parsed = parseVerificationConfig(text);
    if (!parsed.ok) {
      this._postMessage({
        type: 'notice', level: 'warning',
        text: `verification.json is invalid and will be IGNORED this turn: ${parsed.error}`,
      });
      log(`verification.json rejected: ${parsed.error}`);
      return;
    }
    this._verificationConfig = parsed.config;
  }

  /** Run the configured metric commands once, just before the first mutation. */
  private _captureMetricBaseline(): Promise<void> {
    const cfg = this._verificationConfig;
    if (!cfg || Object.keys(cfg.metrics).length === 0) { return Promise.resolve(); }
    if (!this._metricBaselinePromise) {
      this._metricBaselinePromise = (async () => {
        const values = await this._runMetricCommands(cfg);
        this._metricBaseline = values;
        const shown = Object.entries(values)
          .map(([k, v]) => `${k}=${v === undefined ? '?' : v}`).join(', ');
        this._postMessage({ type: 'toolActivity', label: `metrics baseline: ${shown}` });
        log(`Metric baseline captured: ${shown}`);
      })().catch(err => { log(`Metric baseline failed: ${err.message}`); this._metricBaseline = {}; });
    }
    return this._metricBaselinePromise;
  }

  private async _runMetricCommands(cfg: VerificationConfig): Promise<Record<string, number | undefined>> {
    const out: Record<string, number | undefined> = {};
    for (const [name, spec] of Object.entries(cfg.metrics)) {
      if (this._stopRequested) { break; }
      const res = await runVerifyCommand(spec.command, cfg.metricTimeoutMs);
      out[name] = res.ok ? parseMetricValue(res.output) : undefined;
    }
    return out;
  }

  /**
   * Metric gate: candidate metric runs compared against the turn's baseline
   * under the configured thresholds. A regression beyond threshold is fed back
   * as a bounded fix round; at the terminal round it is reported and the
   * failed evidence rejects the experiment. Returns true if it recursed.
   */
  private async _runMetricsGate(round: number): Promise<boolean> {
    const cfg = this._verificationConfig;
    if (!cfg || Object.keys(cfg.metrics).length === 0) { return false; }
    if (!getConfig().agentRunCommands || this._turnMutatedPaths.size === 0) { return false; }
    if (!this._metricBaseline) { return false; }   // nothing mutated before gates — nothing to compare

    this._postMessage({ type: 'toolActivity', label: `metrics: measuring candidate (${Object.keys(cfg.metrics).length})` });
    const candidate = await this._runMetricCommands(cfg);
    const rows = compareMetrics(cfg.metrics, this._metricBaseline, candidate);
    const failures = rows.filter(r => !r.ok);
    const report = renderMetricComparisons(rows);
    log(`Metric gate:\n${report}`);

    for (const r of rows) {
      this._turnEvidence.push(makeEvidence('BENCHMARK', 'gate:metrics',
        `metric ${r.name}: ${r.detail}`, r.ok ? 'pass' : 'fail', 'post-edit'));
    }

    if (failures.length === 0) {
      this._postMessage({ type: 'toolActivity', label: `✓ metrics: no regression (${rows.length} compared)` });
      return false;
    }

    this._runLog?.append('gate', { gate: 'metrics', result: 'failed', failures: failures.length });
    if (round >= getConfig().diagnosticsMaxRounds || this._stopRequested) {
      // Terminal: report honestly; the failed BENCHMARK evidence rejects the
      // experiment in the acceptance decision.
      this._postMessage({
        type: 'notice', level: 'warning',
        text: `Metric regression detected and fix rounds are exhausted:\n${report}`,
      });
      return false;
    }
    this._postMessage({ type: 'toolActivity', label: `✗ metric regression (${failures.length}) — fixing` });
    const feedback =
      `AUTOMATIC METRIC GATE (not user feedback): the project's configured metrics ` +
      `regressed beyond their thresholds after your changes:\n${report}\n\nBaseline was measured ` +
      `BEFORE your first edit this turn. Fix the regression with targeted changes (or revert the ` +
      `part causing it) — the metrics will be re-measured. Do not declare the task done while a ` +
      `required metric fails.`;
    this._history.push({ role: 'user', content: feedback });
    const context = gatherContext();
    const systemPrompt = buildSystemPrompt(context);
    await this._streamResponse(systemPrompt, feedback, context, undefined, round + 1);
    return true;
  }

  private async _runVerifyGate(writtenPaths: Set<string>, round: number): Promise<boolean> {
    const config = getConfig();
    if (!config.verifyGate || !config.agentRunCommands || writtenPaths.size === 0) { return false; }
    if (round >= config.diagnosticsMaxRounds) {
      log(`Verify gate: reached max ${config.diagnosticsMaxRounds} round(s)`);
      return false;
    }

    // Precedence: the codeflare.verifyCommand setting > the project's
    // .codeflare/verification.json > the cheapest sound check for EACH detected
    // stack that owns a file changed this turn — so a repo-wide edit verifies
    // every touched module, not one global command.
    let steps: { label: string; command: string; root: string }[];
    if (config.verifyCommand) {
      steps = [{ label: 'configured', command: config.verifyCommand, root: '.' }];
    } else if (this._verificationConfig?.verify.length) {
      steps = this._verificationConfig.verify.map(c =>
        ({ label: 'verification.json', command: c, root: '.' }));
    } else {
      steps = (await verifyStepsForChanges([...writtenPaths]))
        .map(s => ({ label: `${s.label} @ ${s.root}`, command: s.command, root: s.root }));
    }
    if (steps.length === 0) {
      log('Verify gate: no verify step for the changed modules — skipping');
      return false;
    }

    // Signature of a step's module = the changed files under its root. If a step
    // already passed this turn and its module's files are unchanged since, don't
    // run it again (a fix round in module A shouldn't re-verify green module B) —
    // just tell the model it's still verified.
    const changed = [...writtenPaths].map(p => p.replace(/\\/g, '/'));
    const sigFor = (root: string) =>
      changed.filter(p => root === '.' || p === root || p.startsWith(root + '/')).sort().join('|');

    const failures: string[] = [];
    let executed = 0;
    for (const step of steps) {
      if (this._stopRequested) { return false; }
      const sig = `${step.command}::${sigFor(step.root)}`;
      if (this._verifiedSteps.has(sig)) {
        this._postMessage({ type: 'toolActivity', label: `✓ already verified (unchanged): ${step.label}` });
        log(`Verify gate: skipping "${step.command}" — already verified, ${step.root} unchanged`);
        if (this._turnMetrics) { this._turnMetrics.verifyRunsSkipped++; }
        continue;
      }
      this._postMessage({ type: 'toolActivity', label: `verifying (${step.label}): ${step.command}` });
      log(`Verify gate: running "${step.command}" [${step.label}]`);
      if (this._turnMetrics) { this._turnMetrics.verifyRuns++; }
      const { ok, output } = await runVerifyCommand(step.command, config.verifyTimeout);
      if (ok) {
        executed++;
        this._verifiedSteps.set(sig, '1');
        this._turnEvidence.push(makeEvidence('BUILD', 'gate:verify',
          `verify gate: ${step.command.slice(0, 100)} → passed`, 'pass', 'post-edit'));
        this._postMessage({ type: 'toolActivity', label: `✓ verified: ${step.label}` });
      } else if (this._isMissingToolFailure(step.command, output)) {
        // The verification tool isn't installed — not a code fault. Skip it
        // rather than triggering an unfixable loop (we never auto-install).
        this._postMessage({ type: 'toolActivity', label: `verify skipped (${step.label}): tool not installed` });
        log(`Verify gate: skipped "${step.command}" — tool not on PATH`);
      } else {
        executed++;
        if (this._turnMetrics) { this._turnMetrics.verifyFailures++; this._turnMetrics.verified = 'failed'; }
        this._turnEvidence.push(makeEvidence('BUILD', 'gate:verify',
          `verify gate: ${step.command.slice(0, 100)} → FAILED`, 'fail', 'post-edit'));
        failures.push(`### ${step.label} — \`${step.command}\`\n${output}`);
      }
    }
    if (failures.length === 0) {
      // A real verify command ran and passed → verification demonstrated clean.
      if (executed > 0) {
        if (this._turnMetrics) { this._turnMetrics.verified = 'clean'; }
        this._turnGates.verify = 'clean';
      } else if (!this._turnGates.verify) {
        this._turnGates.verify = 'skipped';
      }
      log('Verify gate: all step(s) passed');
      return false;
    }
    this._turnGates.verify = 'failed';
    this._runLog?.append('gate', { gate: 'verify', result: 'failed', failures: failures.length });
    if (this._stopRequested) { return false; }

    this._postMessage({ type: 'toolActivity', label: `verification failed (${failures.length}) — fixing` });
    log(`Verify gate: ${failures.length} step(s) FAILED → fix round ${round + 1}`);

    const feedback =
      `AUTOMATIC VERIFICATION (not user feedback): the project verification below failed after your ` +
      `changes. Read the output, find the cause, and fix it with targeted edits — then it will be ` +
      `re-run. Do not declare the task done while this fails.\n\n${failures.join('\n\n')}`;
    this._history.push({ role: 'user', content: feedback });
    const context = gatherContext();
    const systemPrompt = buildSystemPrompt(context);
    await this._streamResponse(systemPrompt, feedback, context, undefined, round + 1);
    return true;
  }

  /**
   * Post-process: when the model dumps a full code block instead of
   * SEARCH/REPLACE blocks, diff it against the active file and convert
   * to SEARCH/REPLACE format so the UI renders a nice inline diff.
   */
  private _postProcessCodeDump(response: string, fileContent: string): string | null {
    // Extract the first large code block
    const codeMatch = response.match(/```(?:\w+)?\n([\s\S]*?)```/);
    if (!codeMatch || codeMatch[1].trim().length < 100) { return null; }

    const newCode = codeMatch[1].trimEnd();
    const oldCode = fileContent.trimEnd();

    if (newCode === oldCode) { return null; }

    const oldLines = oldCode.split('\n');
    const newLines = newCode.split('\n');

    // Sanity check: if fewer than 20% of lines match, the model
    // probably generated something unrelated — don't convert
    const minLen = Math.min(oldLines.length, newLines.length);
    let matchCount = 0;
    for (let i = 0; i < minLen; i++) {
      if (oldLines[i] === newLines[i]) { matchCount++; }
    }
    if (minLen > 10 && matchCount < minLen * 0.15) { return null; }

    // Find first differing line (matching prefix)
    let firstDiff = 0;
    while (firstDiff < oldLines.length && firstDiff < newLines.length
           && oldLines[firstDiff] === newLines[firstDiff]) {
      firstDiff++;
    }

    // Find last differing line (matching suffix)
    let lastDiffOld = oldLines.length - 1;
    let lastDiffNew = newLines.length - 1;
    while (lastDiffOld > firstDiff && lastDiffNew > firstDiff
           && oldLines[lastDiffOld] === newLines[lastDiffNew]) {
      lastDiffOld--;
      lastDiffNew--;
    }

    // Add context lines around the changed region
    const ctx = 3;
    const sStart = Math.max(0, firstDiff - ctx);
    const sEnd = Math.min(oldLines.length - 1, lastDiffOld + ctx);
    const rStart = Math.max(0, firstDiff - ctx);
    const rEnd = Math.min(newLines.length - 1, lastDiffNew + ctx);

    const searchBlock = oldLines.slice(sStart, sEnd + 1).join('\n');
    const replaceBlock = newLines.slice(rStart, rEnd + 1).join('\n');

    if (searchBlock === replaceBlock) { return null; }

    // Extract any explanation text outside the code block
    const explanation = response
      .replace(/```(?:\w+)?\n[\s\S]*?```/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    let converted = '';
    if (explanation) { converted += explanation + '\n\n'; }
    converted += `<<<<<<< SEARCH\n${searchBlock}\n=======\n${replaceBlock}\n>>>>>>> REPLACE`;

    log(`Converted code dump to SEARCH/REPLACE (${searchBlock.split('\n').length}→${replaceBlock.split('\n').length} lines)`);
    return converted;
  }

  /**
   * Auto-apply SEARCH/REPLACE blocks to the active editor.
   * Shows a diff preview so the user can accept or reject changes.
   * If the model returned a full code block instead, show diff for that too.
   */
  private async _autoApplyResponse(response: string): Promise<void> {
    const editor = resolveActiveEditor();
    if (!editor) { return; }

    // Skip non-file documents (e.g. output panels, diff previews)
    if (editor.document.uri.scheme !== 'file') { return; }

    if (hasEditBlocks(response)) {
      // Response contains SEARCH/REPLACE blocks — apply them with diff preview
      const blocks = parseEditBlocks(response);
      if (blocks.length > 0) {
        log(`Auto-applying ${blocks.length} edit block(s) to ${editor.document.uri.fsPath}`);
        const result = await applyEditsWithDiff(editor.document, blocks);
        // Notify the webview about the result
        if (result) {
          this._postMessage({
            type: 'editApplied',
            file: path.basename(editor.document.uri.fsPath),
            applied: result.applied,
            failed: result.failed,
          });
        }
      }
    } else {
      // Fallback: if model returned a full code block despite instructions,
      // still show it as a diff so the user can apply it
      const codeMatch = response.match(/```(?:\w+)?\n([\s\S]*?)```/);
      if (codeMatch && codeMatch[1].trim().length > 100) {
        const newCode = codeMatch[1].trimEnd();
        const currentCode = editor.document.getText();

        if (newCode !== currentCode) {
          log(`Fallback: full code block (${newCode.length} chars) — showing diff`);
          const provider = getPreviewProvider();
          const previewUri = vscode.Uri.parse(
            `codeflare-preview:${editor.document.uri.path}?modified`
          );
          provider.setContent(previewUri, newCode);

          await vscode.commands.executeCommand(
            'vscode.diff',
            editor.document.uri,
            previewUri,
            `${path.basename(editor.document.uri.fsPath)}: CodeFlare Changes`
          );

          const accepted = await vscode.window.showInformationMessage(
            'CodeFlare generated updated code. Apply to file?',
            'Accept',
            'Reject'
          );

          if (accepted === 'Accept') {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
              editor.document.uri,
              new vscode.Range(0, 0, editor.document.lineCount, 0),
              newCode
            );
            await vscode.workspace.applyEdit(edit);
            log(`Replaced file content in ${editor.document.uri.fsPath}`);
            this._postMessage({
              type: 'editApplied',
              file: path.basename(editor.document.uri.fsPath),
              applied: 1,
              failed: 0,
            });
          }

          await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
      }
    }
  }

  private async _handleApplyEdit(searchReplace: { search: string; replace: string }): Promise<void> {
    const editor = resolveActiveEditor();
    if (!editor) {
      vscode.window.showWarningMessage('No active editor to apply edit to');
      return;
    }

    const blocks = [searchReplace];
    await applyEditsWithDiff(editor.document, blocks);
  }

  private async _handleInsertCode(code: string): Promise<void> {
    const editor = resolveActiveEditor();
    if (!editor) {
      vscode.window.showWarningMessage('No active editor to insert code into');
      return;
    }

    const position = editor.selection.active;
    await editor.edit(editBuilder => {
      editBuilder.insert(position, code);
    });
  }

  private async _handleReplaceCode(code: string): Promise<void> {
    const editor = resolveActiveEditor();
    if (!editor) {
      vscode.window.showWarningMessage('No active editor to replace code in');
      return;
    }

    const document = editor.document;
    const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
    await editor.edit(editBuilder => {
      editBuilder.replace(fullRange, code);
    });
  }

  private async _handleRunCommand(command: string): Promise<void> {
    const proceed = await vscode.window.showWarningMessage(
      `Run command: ${command}`,
      { modal: true },
      'Run'
    );

    if (proceed === 'Run') {
      let terminal = vscode.window.terminals.find(t => t.name === 'CodeFlare');
      if (!terminal) {
        terminal = vscode.window.createTerminal('CodeFlare');
      }
      terminal.show();
      terminal.sendText(command);
    }
  }

  private _postMessage(msg: any): void {
    this._panel?.webview.postMessage(msg);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.css')
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.js')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src data: ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${cssUri}" rel="stylesheet">
  <title>CodeFlare Chat</title>
</head>
<body>
  <div id="chat-container">
    <div id="messages"></div>
    <div id="input-area">
      <div id="attachments"></div>
      <div class="input-row">
        <button id="attach-btn" title="Attach files (images, text, json, …)">&#128206;</button>
        <input type="file" id="file-input" multiple style="display:none"
          accept="image/*,application/pdf,.pdf,text/*,.txt,.md,.json,.csv,.tsv,.xml,.yaml,.yml,.html,.css,.js,.ts,.tsx,.jsx,.py,.java,.c,.cpp,.cs,.go,.rs,.rb,.php,.sh,.ps1,.sql,.log,.ini,.toml" />
        <textarea id="user-input" placeholder="Ask about your code…  (paste an image to attach)" rows="1"></textarea>
        <button id="copylog-btn" title="Copy chat + extension log to clipboard">&#128203;</button>
        <button id="export-btn" title="Export chat as markdown (with screenshots)">&#128190;</button>
      </div>
      <div class="input-actions">
        <button id="clear-btn" title="Clear chat">Clear</button>
        <button id="stop-btn" title="Stop generation" style="display:none">Stop</button>
        <button id="send-btn" title="Send (Enter)">Send</button>
      </div>
    </div>
    <div id="status-bar">
      <span class="status-dot"></span>
      <span id="status-label">VLLM</span>
      <span id="endpoint-label" title=""></span>
      <span id="speed-label" title="Generation speed of the last response"></span>
      <span id="ctx-meter" title="Context window usage">
        <span id="ctx-bar"><span id="ctx-fill"></span></span>
        <span id="ctx-label"></span>
      </span>
      <button id="config-btn" title="Configure endpoint & token">&#9881;</button>
      <span id="version-label">v${this._version}</span>
    </div>

    <div id="config-overlay" class="hidden">
      <div id="config-panel">
        <div class="config-tabs">
          <button class="config-tab active" data-tab="connection">Connection</button>
          <button class="config-tab" data-tab="commands">Commands</button>
        </div>

        <div class="config-pane" data-pane="connection">
          <label class="config-field">
            <span>Provider</span>
            <select id="cfg-provider">
              <option value="local">Local (OpenAI-compatible)</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic (Claude)</option>
            </select>
          </label>
          <label class="config-field">
            <span>Endpoint URL</span>
            <input id="cfg-endpoint" type="text" placeholder="http://localhost:8001" />
          </label>
          <label class="config-field">
            <span>Model</span>
            <input id="cfg-model" type="text" placeholder="model name (e.g. gpt-4o)" />
          </label>
          <label class="config-field">
            <span>API token</span>
            <input id="cfg-token" type="password" placeholder="leave blank for none" autocomplete="off" />
            <small id="cfg-token-hint"></small>
          </label>
          <div class="config-hint" id="cfg-provider-hint"></div>
        </div>

        <div class="config-pane hidden" data-pane="commands">
          <label class="config-check">
            <input id="cfg-confirm-commands" type="checkbox" />
            <span>Ask before the agent runs a command (except trusted ones below)</span>
          </label>
          <label class="config-field">
            <span>Trusted commands — run without asking (one per line)</span>
            <textarea id="cfg-trusted" rows="8" placeholder="mkdir&#10;ls&#10;git status"></textarea>
          </label>
          <div class="config-hint">A command runs without a prompt if it equals or starts with one of these. Keep this list to safe, non-destructive commands.</div>
        </div>

        <div class="config-actions">
          <button id="cfg-cancel">Cancel</button>
          <button id="cfg-save" class="primary">Save</button>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}
