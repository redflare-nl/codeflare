/**
 * Pruning of tool results — between turns (the stored history) and, new, WITHIN
 * a turn (the running message list the agent loop re-sends on every call).
 *
 * Why within a turn: an agentic turn appends an assistant message and tool
 * results on every step, and every model call re-sends all of it. A turn with
 * 139 tool calls grew its prompt to the point where one turn cost ~5M tokens.
 * Most of that is dead weight: a file that was read again later, a read made
 * stale by an edit, a 20 kB test log from twenty steps ago.
 *
 * Why NOT on every call: llama.cpp reuses its KV cache for an unchanged prompt
 * PREFIX, so an append-only turn only processes the new tokens per call.
 * Rewriting an old message invalidates everything after it. So the TurnPruner
 * acts rarely: once the turn passes a fraction of the window, and again only
 * after substantial further growth — one cache rebuild per pass, append-only
 * in between.
 *
 * What is never touched: system, user and assistant messages (the request,
 * decisions, the model's reasoning), and the most recent tool results. Pruned
 * content is replaced by a stub that says how to get it back (re-read/re-run),
 * and tool_call_id pairing is always preserved. Pure: no vscode.
 */
import type { ChatMessage } from './client';
import { estimatePromptTokens } from './contextFit';

const EDIT_TOOLS = new Set(['edit_file', 'create_file', 'move_file']);

function args(raw: string | undefined): any {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

/**
 * Replace the CONTENT of tool results that are superseded (the same call ran
 * again later) or stale (a file was edited after it was read) with a short
 * stub. Returns a new array; changed messages are copies, others are shared.
 */
export function compactToolResults(messages: ChatMessage[]): ChatMessage[] {
  const callInfo = new Map<string, { name: string; key: string; path?: string }>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        const a = args(tc.function.arguments);
        callInfo.set(tc.id, { name: tc.function.name, key: `${tc.function.name}:${tc.function.arguments || ''}`, path: a.path ?? a.destination ?? a.source });
      }
    }
  }
  const lastIdxForKey = new Map<string, number>();
  const editIndexByPath = new Map<string, number[]>();
  messages.forEach((m, i) => {
    if (m.role === 'tool' && m.tool_call_id) {
      const info = callInfo.get(m.tool_call_id);
      if (info) { lastIdxForKey.set(info.key, i); }
    }
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (!EDIT_TOOLS.has(tc.function.name)) { continue; }
        const a = args(tc.function.arguments);
        const p = a.path ?? a.destination;
        if (p) { editIndexByPath.set(p, [...(editIndexByPath.get(p) || []), i]); }
      }
    }
  });
  return messages.map((m, i) => {
    if (m.role !== 'tool' || !m.tool_call_id) { return m; }
    const info = callInfo.get(m.tool_call_id);
    if (!info) { return m; }
    const last = lastIdxForKey.get(info.key);
    if (last !== undefined && last > i) {
      return { ...m, content: `[superseded: a newer ${info.name} result appears later in this conversation]` };
    }
    if (info.name === 'read_file' && info.path && (editIndexByPath.get(info.path) || []).some(idx => idx > i)) {
      return { ...m, content: `[stale: ${info.path} was modified after this read — re-read it if you need the current content]` };
    }
    return m;
  });
}

export interface ElideOptions {
  /** The most recent N tool results are never shortened. */
  keepRecentTools?: number;
  /** Older tool results longer than this are shortened. */
  maxChars?: number;
  head?: number;
  tail?: number;
}

/**
 * Shorten OLD, LONG tool results to their head and tail — a finished step's
 * search listing or test log is rarely needed in full, and the stub says how to
 * get it back. Recent results and every non-tool message stay intact.
 */
export function elideOldToolResults(messages: ChatMessage[], opts: ElideOptions = {}): ChatMessage[] {
  const keepRecent = opts.keepRecentTools ?? 8;
  const maxChars = opts.maxChars ?? 4000;
  const head = opts.head ?? 1200;
  const tail = opts.tail ?? 800;
  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter(i => i >= 0);
  const protectedFrom = toolIdx.length > keepRecent ? toolIdx[toolIdx.length - keepRecent] : 0;
  return messages.map((m, i) => {
    if (m.role !== 'tool' || i >= protectedFrom || typeof m.content !== 'string' || m.content.length <= maxChars) { return m; }
    if (/^\[(superseded|stale|elided)/.test(m.content)) { return m; }
    const cut = m.content.length - head - tail;
    return { ...m, content: `${m.content.slice(0, head)}\n[elided ${cut} chars of an earlier, finished step — re-run or re-read if you need them]\n${m.content.slice(-tail)}` };
  });
}

export interface PruneResult {
  messages: ChatMessage[];
  /** Tool results replaced or shortened in this pass. */
  results: number;
  savedChars: number;
  tokensBefore: number;
  tokensAfter: number;
}

export interface TurnPrunerOptions {
  /** Prune once the turn's prompt exceeds this fraction of the window. */
  triggerFraction?: number;
  /** After a pass, wait until the prompt grew by this fraction of the window again. */
  regrowFraction?: number;
  elide?: ElideOptions;
}

/**
 * Stateful per agent loop. maybePrune() returns undefined on the vast majority
 * of calls (no rewrite, prefix cache intact) and a pruned list only when the
 * turn has grown enough to be worth one cache rebuild.
 */
export class TurnPruner {
  private readonly trigger: number;
  private readonly regrow: number;
  private readonly elide: ElideOptions;
  private nextAt: number;
  passes = 0;

  constructor(private readonly windowTokens: number, opts: TurnPrunerOptions = {}) {
    const window = Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : 32768;
    this.trigger = Math.floor(window * (opts.triggerFraction ?? 0.5));
    this.regrow = Math.floor(window * (opts.regrowFraction ?? 0.15));
    this.elide = opts.elide ?? {};
    this.nextAt = this.trigger;
  }

  maybePrune(messages: ChatMessage[]): PruneResult | undefined {
    const tokensBefore = estimatePromptTokens(messages as any);
    if (tokensBefore < this.nextAt) { return undefined; }
    const pruned = elideOldToolResults(compactToolResults(messages), this.elide);
    let results = 0;
    let savedChars = 0;
    pruned.forEach((m, i) => {
      if (m !== messages[i] && typeof messages[i].content === 'string' && typeof m.content === 'string') {
        results++;
        savedChars += (messages[i].content as string).length - (m.content as string).length;
      }
    });
    const tokensAfter = estimatePromptTokens(pruned as any);
    // Re-arm ABOVE the pre-pass size: the next pass only comes after real new
    // growth, never on the next few calls — each pass costs one cache rebuild.
    this.nextAt = Math.max(tokensAfter, tokensBefore) + this.regrow;
    if (results === 0) { return undefined; }
    this.passes++;
    return { messages: pruned, results, savedChars, tokensBefore, tokensAfter };
  }
}
