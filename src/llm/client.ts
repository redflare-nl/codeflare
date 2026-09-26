import { getConfig, CodeFlareConfig } from '../utils/config';
import { getApiKey } from '../utils/secrets';
import { getContextSize, setContextSize } from '../utils/serverInfo';
import { log } from '../utils/logger';
import { ToolDefinition } from './tools';
import { estimatePromptTokens, fitToContextWindow, parseServerContextSize } from './contextFit';

// Auto mode (maxTokens <= 0): derive the output cap from the context window,
// bounded by this ceiling so a single generation can't grind for many minutes.
// Files are written in ~120-line chunks (enforced), so no legitimate single
// call needs more than a few k tokens — 16k caps a worst-case runaway
// generation at ~12 minutes on local hardware instead of ~25.
const AUTO_MAX_TOKENS = 16384;
// When the server doesn't report a context size (e.g. OpenAI has no /props),
// stay conservative — many OpenAI models reject max_tokens above 16k.
const AUTO_FALLBACK = 8192;

/**
 * Bound the outgoing prompt to the detected context window (see contextFit.ts
 * for the strategy). Logs when anything was trimmed so long agentic turns are
 * diagnosable. `factor` shrinks harder on the retry after a server rejection.
 */
function boundPrompt(messages: ChatMessage[], factor = 0.85): ChatMessage[] {
  const fit = fitToContextWindow(messages, getContextSize(), factor);
  if (fit.trimmed) {
    log(`Prompt trimmed to fit context window: ~${Math.round(fit.beforeTokens / 1000)}k → ` +
      `~${Math.round(fit.afterTokens / 1000)}k est. tokens (window ${getContextSize()})`);
  }
  return fit.messages;
}

/**
 * The most output tokens to request this call. Never exceeds the detected
 * context window minus a rough prompt estimate. With maxTokens <= 0 (auto) it
 * scales to the window; with an explicit value that value is the ceiling.
 */
function effectiveMaxTokens(messages: ChatMessage[], configuredMax: number): number {
  const ctx = getContextSize();
  const budget = ctx ? ctx - estimatePromptTokens(messages) - 1024 : undefined;

  if (configuredMax && configuredMax > 0) {
    // Explicit cap — still bounded by the window when we know it.
    return budget ? Math.max(256, Math.min(configuredMax, budget)) : configuredMax;
  }
  // Auto: use the window budget, capped to avoid runaway output.
  if (!budget) { return AUTO_FALLBACK; }
  return Math.max(512, Math.min(AUTO_MAX_TOKENS, budget));
}

// Anthropic's Messages API version pin. Stable value from the docs.
const ANTHROPIC_VERSION = '2023-06-01';

function buildHeaders(config: Pick<CodeFlareConfig, 'provider'>): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const { provider } = config;
  // The key is looked up for the provider actually being called — a judge on a
  // different provider than the worker needs its own credential.
  const key = getApiKey(provider);
  if (provider === 'anthropic') {
    // Native Anthropic auth: x-api-key + a version pin (NOT Bearer).
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    if (key) { headers['x-api-key'] = key; }
  } else if (key) {
    headers['Authorization'] = `Bearer ${key}`;
  }
  return headers;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface TextPart {
  type: 'text';
  text: string;
}
export interface ImagePart {
  type: 'image_url';
  image_url: { url: string };
}
export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onThinking: (text: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
  // Fired as a tool call's arguments stream in (so the UI can show progress
  // while the model generates a large file that has no visible content tokens).
  onToolProgress?: (info: { name?: string; chars: number }) => void;
  // Fired periodically while waiting for the FIRST byte of a response — the
  // server may be re-evaluating a large prompt for minutes with no output, and
  // without a live signal the UI looks frozen.
  onWaiting?: (info: { seconds: number; promptTokens: number }) => void;
}

export interface StreamResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  // First chunk of hidden reasoning (reasoning_content) — used to detect a
  // tool call that leaked into the reasoning channel as literal text.
  reasoning: string;
  // Rough per-call stats for the UI (context meter + tokens/sec).
  stats?: { promptTokens: number; completionTokens: number; genSeconds: number };
}

function splitFirst(str: string, sep: string): [string, string] {
  const idx = str.indexOf(sep);
  if (idx === -1) { return [str, '']; }
  return [str.slice(0, idx), str.slice(idx + sep.length)];
}

/**
 * Detects a runaway repetition loop: a chunk of 12–300 chars repeated back-to-back
 * many times at the tail. Conservative thresholds (≥600 chars of pure repeat, ≥8
 * reps) so normal repetitive code (maze rows etc.) doesn't trip it.
 */
function isRepeating(s: string): boolean {
  const tail = s.slice(-1400);
  if (tail.length < 300) { return false; }
  for (let len = 12; len <= 300; len++) {
    const unit = tail.slice(tail.length - len);
    let count = 1;
    let pos = tail.length - 2 * len;
    while (pos >= 0 && tail.substr(pos, len) === unit) { count++; pos -= len; }
    if (count >= 6 && count * len >= 500) { return true; }
  }
  return false;
}

// ── Anthropic (native Messages API) conversion ───────────────────
// The rest of the extension speaks the OpenAI chat shape internally. These
// helpers translate that shape to/from Anthropic's Messages API at the wire
// boundary so the agent loop, tools, and UI stay provider-agnostic.

function contentToText(content: string | ContentPart[]): string {
  if (typeof content === 'string') { return content; }
  return content.filter(p => p.type === 'text').map(p => (p as TextPart).text).join('');
}

/** OpenAI image_url (data: URL or http URL) → Anthropic image block. */
function toAnthropicImage(url: string): any {
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(url);
  if (m) { return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }; }
  return { type: 'image', source: { type: 'url', url } };
}

function contentToAnthropicBlocks(content: string | ContentPart[]): any[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  const blocks: any[] = [];
  for (const p of content) {
    if (p.type === 'text') { if (p.text) { blocks.push({ type: 'text', text: p.text }); } }
    else if (p.type === 'image_url') { blocks.push(toAnthropicImage(p.image_url.url)); }
  }
  return blocks;
}

/**
 * Convert internal OpenAI-shaped messages to Anthropic's `{system, messages}`.
 * System turns are hoisted to the top-level `system` string; `tool` results
 * become `tool_result` blocks inside a user turn (merged with adjacent ones so
 * a parallel tool batch lands in a single user message, as Anthropic expects).
 */
function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: any[] } {
  const systemParts: string[] = [];
  const out: any[] = [];
  const pushUser = (blocks: any[]) => {
    if (!blocks.length) { return; }
    const last = out[out.length - 1];
    if (last && last.role === 'user') { last.content.push(...blocks); }
    else { out.push({ role: 'user', content: blocks }); }
  };
  for (const m of messages) {
    if (m.role === 'system') {
      const text = contentToText(m.content);
      if (text) { systemParts.push(text); }
    } else if (m.role === 'tool') {
      pushUser([{
        type: 'tool_result',
        tool_use_id: m.tool_call_id || '',
        content: typeof m.content === 'string' ? m.content : contentToAnthropicBlocks(m.content),
      }]);
    } else if (m.role === 'assistant') {
      const blocks = contentToAnthropicBlocks(m.content);
      for (const tc of m.tool_calls || []) {
        let input: any = {};
        try { input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      // Anthropic rejects an empty content array.
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
    } else {
      const blocks = contentToAnthropicBlocks(m.content);
      pushUser(blocks.length ? blocks : [{ type: 'text', text: ' ' }]);
    }
  }
  // The Anthropic Messages API requires the first message to be role 'user'. A
  // trimmed history window can begin with an assistant(tool_calls) turn (a large
  // prior agentic turn fills the window; the new user turn is appended
  // separately), which would 400. Prepend a stub so the request is valid; the
  // following tool_use/tool_result pairing stays intact.
  if (out.length && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: '(earlier context trimmed)' }] });
  }
  return { system: systemParts.join('\n\n'), messages: out };
}

/** OpenAI function-tool schema → Anthropic tool schema. */
function toAnthropicTools(tools?: ToolDefinition[]): any[] | undefined {
  if (!tools || !tools.length) { return undefined; }
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

/** Map an Anthropic stop_reason to the finishReason the agent loop expects. */
function mapAnthropicStop(sr: string | null | undefined): string {
  switch (sr) {
    case 'max_tokens': return 'length';
    case 'tool_use': return 'tool_calls';
    case 'refusal': return 'refusal';
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn': return 'stop';
    default: return sr || 'stop';
  }
}

import type { ClientTarget } from './judge';

export class VLLMClient {
  private abortController: AbortController | null = null;

  /**
   * Without a target the client follows the live settings exactly as before.
   * With one it is pinned to another provider/endpoint/model — the independent
   * judge — while everything else (timeouts, prompt bounding) stays shared.
   */
  constructor(private readonly target?: ClientTarget) {}

  private config(): CodeFlareConfig {
    const config = this.config();
    return this.target ? { ...config, ...this.target } : config;
  }

  /** "provider:model" of what this client actually calls (for labels and logs). */
  describe(): string {
    const { provider, model } = this.config();
    return `${provider}:${model}`;
  }

  async checkHealth(): Promise<boolean> {
    const config = this.config();
    try {
      // /v1/models works for both VLLM and OpenAI-compatible endpoints
      // and respects the auth token, unlike VLLM's /health.
      const resp = await fetch(`${config.endpoint}/v1/models`, {
        headers: buildHeaders(config),
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /** One-shot, non-streaming completion (used for context compaction). */
  async complete(messages: ChatMessage[], maxTokens = 1200): Promise<string> {
    const config = this.config();
    messages = boundPrompt(messages);
    if (config.provider === 'anthropic') {
      return this.completeAnthropic(messages, maxTokens, config);
    }
    const resp = await fetch(`${config.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: effectiveMaxTokens(messages, maxTokens),
        temperature: 0.2,
        stream: false,
      }),
      // Scale the deadline to prompt size like the streaming path does (~150
      // tok/s prefill). Compaction prompts are the largest the extension sends;
      // a flat idle timeout aborts mid-prefill so compaction could never finish.
      signal: AbortSignal.timeout(
        Math.max(config.streamIdleTimeout, 60000 + Math.ceil(estimatePromptTokens(messages) / 150) * 1000)
      ),
    });
    if (!resp.ok) {
      throw new Error(`Compaction request failed: ${resp.status}`);
    }
    const data: any = await resp.json();
    // A response truncated at the token cap (finish_reason 'length') is not a
    // usable summary — returning it would let the caller REPLACE real history
    // with a fragment. Signal failure with '' so the caller keeps full history.
    if (data.choices?.[0]?.finish_reason === 'length') { return ''; }
    const content: string = data.choices?.[0]?.message?.content ?? '';
    // Strip reasoning: closed <think>…</think> blocks AND an unclosed <think>…
    // tail — a reasoning model (Qwen3.x) can spend its whole budget thinking and
    // emit an unterminated block; left in, raw chain-of-thought becomes the
    // "summary" and overwrites real history.
    return content
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*$/, '')
      .trim();
  }

  async streamChat(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    tools?: ToolDefinition[],
    ctxRetry = false
  ): Promise<StreamResult> {
    const config = this.config();
    if (config.provider === 'anthropic') {
      return this.streamChatAnthropic(messages, callbacks, tools, config);
    }
    // Bound the prompt BEFORE sending — a long agentic turn can outgrow the
    // window mid-turn and the server hard-rejects oversized prompts. On the
    // one retry after such a rejection, shrink harder (the estimator
    // undercounted the first time).
    const originalMessages = messages;
    messages = boundPrompt(messages, ctxRetry ? 0.7 : 0.85);
    this.abortController = new AbortController();

    const result: StreamResult = { content: '', toolCalls: [], finishReason: '', reasoning: '' };
    // Accumulate streamed tool-call fragments by their index.
    const toolAcc: { id: string; name: string; args: string }[] = [];
    // Generation stats for the UI. Declared before finalize (which reads them)
    // because finalize runs on early error paths too.
    let firstByteAt = 0;
    let reasoningChars = 0;

    const finalize = (): StreamResult => {
      result.toolCalls = toolAcc
        .filter(t => t && t.name)
        .map(t => ({
          id: t.id,
          type: 'function' as const,
          function: { name: t.name, arguments: t.args },
        }));
      const toolChars = toolAcc.reduce((n, t) => n + (t?.args?.length || 0), 0);
      const chars = result.content.length + reasoningChars + toolChars;
      result.stats = {
        promptTokens,
        completionTokens: Math.ceil(chars / 3.5),
        genSeconds: firstByteAt ? (Date.now() - firstByteAt) / 1000 : 0,
      };
      return result;
    };

    // Heartbeat while waiting for the first response byte: prompt (re-)evaluation
    // of a big context takes minutes and streams nothing — tell the UI we're alive.
    const promptTokens = estimatePromptTokens(messages);
    const waitStart = Date.now();
    let waitTimer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
      callbacks.onWaiting?.({
        seconds: Math.round((Date.now() - waitStart) / 1000),
        promptTokens,
      });
    }, 10000);
    const stopWaiting = () => { if (waitTimer) { clearInterval(waitTimer); waitTimer = undefined; } };

    let response: Response;
    try {
      response = await fetch(`${config.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: buildHeaders(config),
        body: JSON.stringify({
          model: config.model,
          messages,
          max_tokens: effectiveMaxTokens(messages, config.maxTokens),
          temperature: config.temperature,
          stream: true,
          ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
        }),
        signal: this.abortController.signal,
      });
    } catch (err: any) {
      stopWaiting();
      if (err.name === 'AbortError') {
        callbacks.onDone();
        return finalize();
      }
      callbacks.onError(`Cannot reach VLLM: ${err.message}`);
      return finalize();
    }

    if (!response.ok) {
      stopWaiting();
      const text = await response.text();
      // The prompt no longer fits the model's context window — llama.cpp
      // rejects the whole request. Learn the real n_ctx from the error body
      // (covers the case where /props was unreachable at startup), trim
      // harder, and retry ONCE.
      if (response.status === 400 && /exceed_context_size|exceeds the available context/i.test(text)) {
        const learned = parseServerContextSize(text);
        if (learned) { setContextSize(learned); }
        if (!ctxRetry) {
          log('Prompt exceeded the server context window — trimming and retrying once');
          return this.streamChat(originalMessages, callbacks, tools, true);
        }
        callbacks.onError(
          'The conversation no longer fits the model\'s context window, even after trimming. ' +
          'Clear the chat (or raise the server\'s context size) and try again.');
        return finalize();
      }
      // A common failure: the model put a large file into a tool-call argument
      // and hit the token limit, so the arguments JSON is truncated and the
      // server can't parse it. Give an actionable message instead of the raw body.
      if (response.status === 500 && /parse tool call arguments|invalid string|missing closing quote/i.test(text)) {
        // A tool call (usually a big create_file) exceeded the output limit and
        // was truncated into invalid JSON. Signal it so the caller can recover
        // by asking the model to write the file in smaller parts.
        result.finishReason = 'tool_call_truncated';
        return finalize();
      }
      callbacks.onError(`Server error ${response.status}: ${text.slice(0, 500)}`);
      return finalize();
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let inThinkTag = false;
    let thinkBuffer = '';

    // Idle watchdog: if the server sends nothing for the timeout, the connection
    // has stalled — abort so the UI doesn't hang forever. Before the FIRST byte
    // the server may legitimately be re-evaluating a huge prompt (a 100k-token
    // context takes minutes at a few hundred tok/s), so that timeout scales with
    // the prompt size; once bytes flow, the configured idle timeout applies.
    let stalled = false;
    let looping = false;
    let overthinking = false;
    let gotFirstByte = false;
    let lastRepCheck = 0;
    // Total <think> characters this generation. A model stuck reasoning can
    // grind out tens of thousands of hidden tokens (many MINUTES of "nothing
    // happening") before hitting the token limit — cap it. ~24k chars is far
    // beyond any productive reasoning for a coding step.
    let thinkChars = 0;
    const THINK_CAP = 24000;
    const firstByteTimeout = Math.max(
      config.streamIdleTimeout,
      60000 + Math.ceil(estimatePromptTokens(messages) / 150) * 1000
    );
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      if (idleTimer) { clearTimeout(idleTimer); }
      idleTimer = setTimeout(
        () => { stalled = true; this.abortController?.abort(); },
        gotFirstByte ? config.streamIdleTimeout : firstByteTimeout
      );
    };
    const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; } };

    try {
      resetIdle();
      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }
        stopWaiting();
        if (!gotFirstByte) { firstByteAt = Date.now(); }
        gotFirstByte = true;
        resetIdle();

        buffer += decoder.decode(value, { stream: true });

        // Runaway-thinking guard: endless hidden reasoning with no tool call
        // and no visible output produces nothing and blocks the UI for minutes.
        if (thinkChars > THINK_CAP && toolAcc.length === 0) {
          overthinking = true;
          clearIdle();
          this.abortController?.abort();
          break;
        }

        // Runaway-repetition guard: stop the model if it's stuck looping.
        const grown = result.content.length + toolAcc.reduce((a, t) => a + (t?.args?.length || 0), 0);
        if (grown - lastRepCheck >= 1000) {
          lastRepCheck = grown;
          const combined = result.content + toolAcc.reduce((a, t) => a + (t?.args || ''), '');
          if (isRepeating(combined)) {
            looping = true;
            clearIdle();
            this.abortController?.abort();
            break;
          }
        }

        while (buffer.includes('\n')) {
          const [line, rest] = splitFirst(buffer, '\n');
          buffer = rest;
          const trimmed = line.trim();

          if (!trimmed || !trimmed.startsWith('data: ')) { continue; }
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            // Flush any remaining think buffer
            if (inThinkTag && thinkBuffer) {
              callbacks.onThinking(thinkBuffer);
            }
            clearIdle();
            callbacks.onDone();
            return finalize();
          }

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (!choice) { continue; }

            if (choice.finish_reason) {
              result.finishReason = choice.finish_reason;
            }

            // Accumulate any streamed tool-call fragments.
            const toolDeltas = choice.delta?.tool_calls;
            if (Array.isArray(toolDeltas)) {
              for (const td of toolDeltas) {
                const idx = td.index ?? 0;
                if (!toolAcc[idx]) {
                  toolAcc[idx] = { id: '', name: '', args: '' };
                }
                if (td.id) { toolAcc[idx].id = td.id; }
                if (td.function?.name) { toolAcc[idx].name += td.function.name; }
                if (td.function?.arguments) { toolAcc[idx].args += td.function.arguments; }
              }
              if (callbacks.onToolProgress) {
                const first = toolAcc.find(t => t && t.name);
                const chars = toolAcc.reduce((n, t) => n + (t?.args?.length || 0), 0);
                callbacks.onToolProgress({ name: first?.name, chars });
              }
            }

            // llama.cpp (reasoning-format) can put hidden reasoning in a
            // SEPARATE delta field instead of inline <think> tags. Count and
            // surface it — otherwise a stuck model grinds thousands of
            // invisible tokens straight past every guard (observed: 2× four
            // minutes at finish=length with 0 chars of visible output).
            const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? '';
            if (reasoning) {
              thinkChars += reasoning.length;
              reasoningChars += reasoning.length;
              if (result.reasoning.length < 4000) { result.reasoning += reasoning; }
              callbacks.onThinking(reasoning);
            }

            const token = choice.delta?.content ?? '';
            if (!token) { continue; }
            result.content += token;

            // Handle <think> tags from Qwen3
            let remaining = token;

            while (remaining) {
              if (inThinkTag) {
                const closeIdx = remaining.indexOf('</think>');
                if (closeIdx !== -1) {
                  thinkBuffer += remaining.slice(0, closeIdx);
                  thinkChars += closeIdx;
                  callbacks.onThinking(thinkBuffer);
                  thinkBuffer = '';
                  inThinkTag = false;
                  remaining = remaining.slice(closeIdx + 8);
                } else {
                  thinkBuffer += remaining;
                  thinkChars += remaining.length;
                  remaining = '';
                }
              } else {
                const openIdx = remaining.indexOf('<think>');
                if (openIdx !== -1) {
                  if (openIdx > 0) {
                    callbacks.onToken(remaining.slice(0, openIdx));
                  }
                  inThinkTag = true;
                  remaining = remaining.slice(openIdx + 7);
                } else {
                  callbacks.onToken(remaining);
                  remaining = '';
                }
              }
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } catch (err: any) {
      stopWaiting();
      clearIdle();
      if (err.name === 'AbortError') {
        if (looping) {
          callbacks.onError('The model got stuck repeating the same output and was stopped. Try again, or ask for a smaller/simpler file.');
        } else if (overthinking) {
          // Recoverable: the caller nudges the model to act instead of ending
          // the whole turn with an error.
          result.finishReason = 'overthink';
          callbacks.onDone();
        } else if (stalled) {
          callbacks.onError(`No response from the server for ${Math.round(config.streamIdleTimeout / 1000)}s — the connection stalled. Try again.`);
        } else {
          callbacks.onDone();
        }
        return finalize();
      }
      callbacks.onError(`Stream error: ${err.message}`);
      return finalize();
    }

    stopWaiting();
    clearIdle();
    if (looping) {
      callbacks.onError('The model got stuck repeating the same output and was stopped. Try again, or ask for a smaller/simpler file.');
      return finalize();
    }
    if (overthinking) {
      result.finishReason = 'overthink';
      callbacks.onDone();
      return finalize();
    }
    callbacks.onDone();
    return finalize();
  }

  /** Non-streaming Anthropic completion (compaction path). */
  private async completeAnthropic(
    messages: ChatMessage[], maxTokens: number, config: CodeFlareConfig
  ): Promise<string> {
    const { system, messages: amsgs } = toAnthropicMessages(messages);
    const body: any = {
      model: config.model,
      max_tokens: effectiveMaxTokens(messages, maxTokens),
      messages: amsgs,
      stream: false,
    };
    if (system) { body.system = system; }
    const resp = await fetch(`${config.endpoint}/v1/messages`, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify(body),
      // Scale the deadline to prompt size (compaction prompts are the largest we
      // send), matching complete()'s non-Anthropic path.
      signal: AbortSignal.timeout(
        Math.max(config.streamIdleTimeout, 60000 + Math.ceil(estimatePromptTokens(messages) / 150) * 1000)
      ),
    });
    if (!resp.ok) { throw new Error(`Compaction request failed: ${resp.status}`); }
    const data: any = await resp.json();
    // A truncated response (stop_reason 'max_tokens') is not a usable summary —
    // signal failure with '' so the caller keeps full history.
    if (data.stop_reason === 'max_tokens') { return ''; }
    const text = Array.isArray(data.content)
      ? data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
      : '';
    return text.trim();
  }

  /**
   * Streaming chat against Anthropic's native Messages API. Parses Anthropic's
   * SSE events (message_start / content_block_* / message_delta / message_stop)
   * back into the same StreamResult shape the OpenAI path produces, so the
   * caller is unaware of the provider. Reuses the same idle/repetition guards.
   */
  private async streamChatAnthropic(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    tools: ToolDefinition[] | undefined,
    config: CodeFlareConfig,
  ): Promise<StreamResult> {
    messages = boundPrompt(messages);
    this.abortController = new AbortController();

    const result: StreamResult = { content: '', toolCalls: [], finishReason: '', reasoning: '' };
    const toolAcc: { id: string; name: string; args: string }[] = [];
    // Anthropic streams by content-block index; map block index → toolAcc slot.
    const blockToTool: Record<number, number> = {};
    let firstByteAt = 0;
    let reasoningChars = 0;
    let outputTokens = 0;
    let promptTokensReported = 0;

    const promptTokens = estimatePromptTokens(messages);

    const finalize = (): StreamResult => {
      result.toolCalls = toolAcc
        .filter(t => t && t.name)
        .map(t => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.args } }));
      const toolChars = toolAcc.reduce((n, t) => n + (t?.args?.length || 0), 0);
      result.stats = {
        promptTokens: promptTokensReported || promptTokens,
        completionTokens: outputTokens || Math.ceil((result.content.length + reasoningChars + toolChars) / 3.5),
        genSeconds: firstByteAt ? (Date.now() - firstByteAt) / 1000 : 0,
      };
      return result;
    };

    const waitStart = Date.now();
    let waitTimer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
      callbacks.onWaiting?.({ seconds: Math.round((Date.now() - waitStart) / 1000), promptTokens });
    }, 10000);
    const stopWaiting = () => { if (waitTimer) { clearInterval(waitTimer); waitTimer = undefined; } };

    const { system, messages: amsgs } = toAnthropicMessages(messages);
    const body: any = {
      model: config.model,
      max_tokens: effectiveMaxTokens(messages, config.maxTokens),
      messages: amsgs,
      stream: true,
    };
    if (system) { body.system = system; }
    const atools = toAnthropicTools(tools);
    if (atools) { body.tools = atools; }

    let response: Response;
    try {
      response = await fetch(`${config.endpoint}/v1/messages`, {
        method: 'POST',
        headers: buildHeaders(config),
        body: JSON.stringify(body),
        signal: this.abortController.signal,
      });
    } catch (err: any) {
      stopWaiting();
      if (err.name === 'AbortError') { callbacks.onDone(); return finalize(); }
      callbacks.onError(`Cannot reach Anthropic API: ${err.message}`);
      return finalize();
    }

    if (!response.ok) {
      stopWaiting();
      const text = await response.text();
      callbacks.onError(`Server error ${response.status}: ${text.slice(0, 500)}`);
      return finalize();
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stalled = false;
    let looping = false;
    let gotFirstByte = false;
    let lastRepCheck = 0;
    const firstByteTimeout = Math.max(
      config.streamIdleTimeout,
      60000 + Math.ceil(promptTokens / 150) * 1000
    );
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      if (idleTimer) { clearTimeout(idleTimer); }
      idleTimer = setTimeout(
        () => { stalled = true; this.abortController?.abort(); },
        gotFirstByte ? config.streamIdleTimeout : firstByteTimeout
      );
    };
    const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; } };

    try {
      resetIdle();
      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }
        stopWaiting();
        if (!gotFirstByte) { firstByteAt = Date.now(); }
        gotFirstByte = true;
        resetIdle();

        buffer += decoder.decode(value, { stream: true });

        const grown = result.content.length + toolAcc.reduce((a, t) => a + (t?.args?.length || 0), 0);
        if (grown - lastRepCheck >= 1000) {
          lastRepCheck = grown;
          const combined = result.content + toolAcc.reduce((a, t) => a + (t?.args || ''), '');
          if (isRepeating(combined)) {
            looping = true;
            clearIdle();
            this.abortController?.abort();
            break;
          }
        }

        while (buffer.includes('\n')) {
          const [line, rest] = splitFirst(buffer, '\n');
          buffer = rest;
          const trimmed = line.trim();
          // Anthropic SSE interleaves `event:` and `data:` lines; the JSON on
          // the data line carries its own `type`, so we dispatch on that and
          // ignore the event: lines entirely.
          if (!trimmed.startsWith('data:')) { continue; }
          const data = trimmed.slice(trimmed.indexOf(':') + 1).trim();
          if (!data) { continue; }

          let ev: any;
          try { ev = JSON.parse(data); } catch { continue; }

          switch (ev.type) {
            case 'message_start':
              promptTokensReported = ev.message?.usage?.input_tokens || promptTokensReported;
              break;
            case 'content_block_start': {
              const idx = ev.index ?? 0;
              const cb = ev.content_block || {};
              if (cb.type === 'tool_use') {
                blockToTool[idx] = toolAcc.push({ id: cb.id || '', name: cb.name || '', args: '' }) - 1;
                callbacks.onToolProgress?.({ name: cb.name, chars: 0 });
              } else if (cb.type === 'text' && cb.text) {
                result.content += cb.text;
                callbacks.onToken(cb.text);
              }
              break;
            }
            case 'content_block_delta': {
              const idx = ev.index ?? 0;
              const d = ev.delta || {};
              if (d.type === 'text_delta' && d.text) {
                result.content += d.text;
                callbacks.onToken(d.text);
              } else if (d.type === 'input_json_delta') {
                const ti = blockToTool[idx];
                if (ti != null && toolAcc[ti]) {
                  toolAcc[ti].args += d.partial_json || '';
                  callbacks.onToolProgress?.({
                    name: toolAcc[ti].name,
                    chars: toolAcc.reduce((n, t) => n + (t?.args?.length || 0), 0),
                  });
                }
              } else if ((d.type === 'thinking_delta') && d.thinking) {
                reasoningChars += d.thinking.length;
                if (result.reasoning.length < 4000) { result.reasoning += d.thinking; }
                callbacks.onThinking(d.thinking);
              }
              break;
            }
            case 'message_delta':
              if (ev.delta?.stop_reason) { result.finishReason = mapAnthropicStop(ev.delta.stop_reason); }
              if (ev.usage?.output_tokens) { outputTokens = ev.usage.output_tokens; }
              break;
            case 'message_stop':
              clearIdle();
              callbacks.onDone();
              return finalize();
            case 'error':
              clearIdle();
              stopWaiting();
              callbacks.onError(`Anthropic error: ${ev.error?.message || 'unknown'}`);
              return finalize();
            default:
              break; // ping, content_block_stop, etc.
          }
        }
      }
    } catch (err: any) {
      stopWaiting();
      clearIdle();
      if (err.name === 'AbortError') {
        if (looping) {
          callbacks.onError('The model got stuck repeating the same output and was stopped. Try again, or ask for a smaller/simpler file.');
        } else if (stalled) {
          callbacks.onError(`No response from the server for ${Math.round(config.streamIdleTimeout / 1000)}s — the connection stalled. Try again.`);
        } else {
          callbacks.onDone();
        }
        return finalize();
      }
      callbacks.onError(`Stream error: ${err.message}`);
      return finalize();
    }

    stopWaiting();
    clearIdle();
    if (looping) {
      callbacks.onError('The model got stuck repeating the same output and was stopped. Try again, or ask for a smaller/simpler file.');
      return finalize();
    }
    callbacks.onDone();
    return finalize();
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      log('Stream aborted');
    }
  }
}
