/**
 * Prompt-size discipline for the outgoing request. A long agentic turn appends
 * an assistant turn + tool results on every step, and the conversation-level
 * compaction only runs BETWEEN turns — so mid-turn the prompt can outgrow the
 * model's context window, which llama.cpp rejects outright
 * (exceed_context_size_error) instead of truncating. This module bounds the
 * prompt right before it is sent, without ever mutating the caller's stored
 * history.
 *
 * Pure module (no vscode imports) so it is unit-testable.
 */

/** Structural subset of ChatMessage — kept structural to avoid an import cycle. */
export interface FitMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string }>;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

/**
 * Estimate the prompt's token count. Text counts at ~3.5 chars/token; images
 * count as a flat nominal — their base64 payload is NOT tokenized as text
 * (vision encoders/serverside handling), so counting those chars would wildly
 * overestimate and crush the output budget.
 */
export function estimatePromptTokens(messages: FitMessage[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text') { chars += (p.text || '').length; }
        else { images++; }
      }
    }
    if (m.tool_calls) { chars += JSON.stringify(m.tool_calls).length; }
  }
  return Math.ceil(chars / 3.5) + images * 800;
}

// Room reserved for the generated reply when deciding whether the prompt fits.
const OUTPUT_RESERVE = 2048;
// The newest tool results are the model's working set — never stub them.
const KEEP_RECENT_TOOL_RESULTS = 6;
// Keep this many chars of a stubbed tool result so the model still knows what it was.
const STUB_HEAD_CHARS = 200;
// Never drop the live tail of the conversation (the current exchange).
const KEEP_TAIL_MESSAGES = 3;

export interface FitResult<T extends FitMessage> {
  messages: T[];
  /** true when anything was stubbed or dropped. */
  trimmed: boolean;
  beforeTokens: number;
  afterTokens: number;
}

/**
 * Bound the outgoing prompt to the context window. The chars/3.5 estimate
 * undercounts dense code by 10–15% and the server rejects the WHOLE request
 * once the real prompt passes n_ctx, so the target sits well below the window
 * (factor, default 0.85), minus an output reserve.
 *
 * Shrinks a COPY in two passes:
 *  1. Stub the contents of older tool results (newest few stay intact).
 *  2. Still over: drop the oldest turns after the system prompt, snapping to a
 *     user boundary so assistant(tool_calls) → tool pairing stays valid, and
 *     prepend a marker so the model knows earlier context was trimmed.
 */
export function fitToContextWindow<T extends FitMessage>(
  messages: T[],
  contextSize: number | undefined,
  factor = 0.85
): FitResult<T> {
  const before = estimatePromptTokens(messages);
  const noop: FitResult<T> = { messages, trimmed: false, beforeTokens: before, afterTokens: before };
  if (!contextSize) { return noop; }
  const budget = Math.floor(contextSize * factor) - OUTPUT_RESERVE;
  if (budget <= 0 || before <= budget) { return noop; }

  let out: T[] = messages.slice();

  // Pass 1: stub older tool-result contents (copies only — stored history is
  // never mutated).
  const toolIdx: number[] = [];
  out.forEach((m, i) => { if (m.role === 'tool') { toolIdx.push(i); } });
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_RECENT_TOOL_RESULTS))) {
    if (estimatePromptTokens(out) <= budget) { break; }
    const c = out[i].content;
    if (typeof c === 'string' && c.length > STUB_HEAD_CHARS + 100) {
      out[i] = {
        ...out[i],
        content: c.slice(0, STUB_HEAD_CHARS) + '\n… [old tool result elided to fit the context window]',
      };
    }
  }

  // Pass 2: drop whole turns from the front, after the system prompt, snapping
  // to a user boundary. The final KEEP_TAIL_MESSAGES are never dropped.
  if (estimatePromptTokens(out) > budget) {
    const head = out.length && out[0].role === 'system' ? out.slice(0, 1) : [];
    let body = out.slice(head.length);
    let dropped = false;
    while (estimatePromptTokens([...head, ...body]) > budget) {
      let next = 1;
      while (next < body.length && body[next].role !== 'user') { next++; }
      if (next > body.length - KEEP_TAIL_MESSAGES) { break; }
      body = body.slice(next);
      dropped = true;
    }
    if (dropped) {
      body = [
        {
          role: 'user',
          content: '[Earlier turns were trimmed to fit the context window. Continue the task with the context below.]',
        } as T,
        ...body,
      ];
    }
    out = [...head, ...body];
  }

  const after = estimatePromptTokens(out);
  return { messages: out, trimmed: true, beforeTokens: before, afterTokens: after };
}

/** Parse llama.cpp's exceed-context error body for the real n_ctx, if present. */
export function parseServerContextSize(errorBody: string): number | undefined {
  if (!/exceed_context_size|exceeds the available context/i.test(errorBody)) { return undefined; }
  const m = errorBody.match(/"n_ctx"\s*:\s*(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n > 0) { return n; }
  }
  return undefined;
}
