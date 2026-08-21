import { describe, expect, it } from 'vitest';
import {
  estimatePromptTokens,
  fitToContextWindow,
  parseServerContextSize,
  FitMessage,
} from '../src/llm/contextFit';

const sys = (chars: number): FitMessage => ({ role: 'system', content: 'S'.repeat(chars) });
const user = (chars: number): FitMessage => ({ role: 'user', content: 'U'.repeat(chars) });
const assistantCall = (id: string): FitMessage => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } } as any],
});
const toolResult = (id: string, chars: number): FitMessage => ({
  role: 'tool',
  tool_call_id: id,
  content: 'T'.repeat(chars),
});

/** A synthetic long agentic turn: system + task + N tool exchanges. */
function longTurn(exchanges: number, resultChars: number): FitMessage[] {
  const msgs: FitMessage[] = [sys(2000), user(500)];
  for (let i = 0; i < exchanges; i++) {
    msgs.push(assistantCall(`c${i}`));
    msgs.push(toolResult(`c${i}`, resultChars));
  }
  return msgs;
}

describe('estimatePromptTokens', () => {
  it('counts text at ~3.5 chars/token', () => {
    expect(estimatePromptTokens([user(3500)])).toBe(1000);
  });

  it('counts images as a flat nominal, not their base64 length', () => {
    const msg: FitMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(500000) } } as any,
      ],
    };
    const est = estimatePromptTokens([msg]);
    expect(est).toBeGreaterThan(800);
    expect(est).toBeLessThan(1000);
  });
});

describe('fitToContextWindow', () => {
  it('returns the same array untouched when under budget', () => {
    const msgs = longTurn(3, 1000);
    const fit = fitToContextWindow(msgs, 131072);
    expect(fit.trimmed).toBe(false);
    expect(fit.messages).toBe(msgs);
  });

  it('returns untouched when the context size is unknown', () => {
    const msgs = longTurn(200, 20000);
    const fit = fitToContextWindow(msgs, undefined);
    expect(fit.trimmed).toBe(false);
    expect(fit.messages).toBe(msgs);
  });

  it('stubs OLD tool results first and keeps the newest ones intact', () => {
    // 40 exchanges × 20k chars ≈ 230k tokens against a 131k window.
    const msgs = longTurn(40, 20000);
    const fit = fitToContextWindow(msgs, 131072);
    expect(fit.trimmed).toBe(true);
    expect(fit.afterTokens).toBeLessThanOrEqual(Math.floor(131072 * 0.85) - 2048);

    const tools = fit.messages.filter(m => m.role === 'tool');
    const last6 = tools.slice(-6);
    for (const t of last6) {
      expect((t.content as string).length).toBe(20000); // untouched
    }
    const stubbed = tools.filter(t => (t.content as string).includes('elided to fit'));
    expect(stubbed.length).toBeGreaterThan(0);
  });

  it('never mutates the caller\'s message objects', () => {
    const msgs = longTurn(40, 20000);
    const fit = fitToContextWindow(msgs, 131072);
    expect(fit.trimmed).toBe(true);
    for (const m of msgs.filter(x => x.role === 'tool')) {
      expect((m.content as string).length).toBe(20000);
    }
  });

  it('drops oldest turns at a user boundary when stubbing is not enough', () => {
    // Many huge USER messages (stubbing pass can't touch those).
    const msgs: FitMessage[] = [sys(2000)];
    for (let i = 0; i < 30; i++) { msgs.push(user(60000)); msgs.push({ role: 'assistant', content: 'ok' }); }
    const fit = fitToContextWindow(msgs, 131072);
    expect(fit.trimmed).toBe(true);
    expect(fit.afterTokens).toBeLessThanOrEqual(Math.floor(131072 * 0.85) - 2048);
    // System prompt survives; a trim marker is present.
    expect(fit.messages[0].role).toBe('system');
    expect(fit.messages[1].content).toContain('trimmed to fit the context window');
    // The live tail survives.
    const orig = msgs[msgs.length - 1];
    expect(fit.messages[fit.messages.length - 1]).toEqual(orig);
  });

  it('keeps assistant(tool_calls) → tool pairing valid after dropping turns', () => {
    const msgs: FitMessage[] = [sys(2000)];
    for (let i = 0; i < 25; i++) {
      msgs.push(user(40000));
      msgs.push(assistantCall(`c${i}`));
      msgs.push(toolResult(`c${i}`, 40000));
    }
    const fit = fitToContextWindow(msgs, 131072);
    expect(fit.trimmed).toBe(true);
    // Every tool result in the output must be preceded (somewhere earlier) by
    // the assistant message that issued its call id.
    const seenCalls = new Set<string>();
    for (const m of fit.messages) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls as any[]) { seenCalls.add(tc.id); }
      }
      if (m.role === 'tool') {
        expect(seenCalls.has(m.tool_call_id!)).toBe(true);
      }
    }
  });

  it('shrinks harder with a lower factor (retry path)', () => {
    const msgs = longTurn(40, 20000);
    const normal = fitToContextWindow(msgs, 131072, 0.85);
    const retry = fitToContextWindow(msgs, 131072, 0.7);
    expect(retry.afterTokens).toBeLessThan(normal.afterTokens);
  });
});

describe('parseServerContextSize', () => {
  it('parses n_ctx from a llama.cpp exceed-context error body', () => {
    const body = '{"error":{"code":400,"message":"request (132724 tokens) exceeds the available ' +
      'context size (131072 tokens), try increasing it","type":"exceed_context_size_error",' +
      '"n_prompt_tokens":132724,"n_ctx":131072}}';
    expect(parseServerContextSize(body)).toBe(131072);
  });

  it('returns undefined for unrelated errors', () => {
    expect(parseServerContextSize('{"error":{"message":"model not found"}}')).toBeUndefined();
  });
});
