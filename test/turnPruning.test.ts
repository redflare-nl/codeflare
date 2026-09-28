import { describe, expect, it } from 'vitest';
import { TurnPruner, compactToolResults, elideOldToolResults } from '../src/llm/turnPruning';
import { effectiveAgentLimit } from '../src/engine/agentPool';
import { parseServerSlots } from '../src/utils/serverInfo';

type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: any[]; tool_call_id?: string };

let seq = 0;
/** An assistant tool call plus its result, as the agent loop appends them. */
function call(name: string, a: Record<string, unknown>, result: string): Msg[] {
  const id = `c${++seq}`;
  return [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(a) } }] },
    { role: 'tool', tool_call_id: id, content: result },
  ];
}
const big = (n: number, ch = 'x') => ch.repeat(n);

describe('compactToolResults (shared by history and in-turn pruning)', () => {
  it('stubs a result that a later identical call supersedes, keeping the newest', () => {
    const msgs = [...call('read_file', { path: 'a.ts' }, 'v1'), ...call('read_file', { path: 'a.ts' }, 'v2')];
    const out = compactToolResults(msgs as any);
    expect(out[1].content).toMatch(/^\[superseded/);
    expect(out[3].content).toBe('v2');
  });

  it('stubs a read made stale by a later edit of the same file', () => {
    const msgs = [...call('read_file', { path: 'a.ts' }, 'old'), ...call('edit_file', { path: 'a.ts', search: 'x', replace: 'y' }, 'Edited a.ts')];
    const out = compactToolResults(msgs as any);
    expect(out[1].content).toMatch(/^\[stale: a\.ts was modified/);
  });

  it('never mutates its input and keeps tool_call_id pairing', () => {
    const msgs = [...call('read_file', { path: 'a.ts' }, 'v1'), ...call('read_file', { path: 'a.ts' }, 'v2')];
    const before = JSON.stringify(msgs);
    const out = compactToolResults(msgs as any);
    expect(JSON.stringify(msgs)).toBe(before);
    expect(out.map(m => (m as Msg).tool_call_id)).toEqual(msgs.map(m => m.tool_call_id));
  });
});

describe('elideOldToolResults', () => {
  it('shortens only OLD, LONG tool results, to head + tail with a recovery hint', () => {
    const msgs: Msg[] = [{ role: 'user', content: big(10000, 'u') }];
    for (let i = 0; i < 10; i++) { msgs.push(...call('run_command', { command: `test ${i}` }, big(6000, String(i)))); }
    const out = elideOldToolResults(msgs as any, { keepRecentTools: 8, maxChars: 4000, head: 100, tail: 50 });
    const tools = out.filter(m => m.role === 'tool');
    expect(tools[0].content).toMatch(/\[elided \d+ chars of an earlier, finished step — re-run or re-read/);
    expect((tools[0].content as string).startsWith(big(100, '0'))).toBe(true);
    expect(tools[1].content).toMatch(/\[elided/);
    // The last 8 results are protected.
    for (const t of tools.slice(2)) { expect((t.content as string).length).toBe(6000); }
    // The user's message is never touched, however long.
    expect(out[0].content).toBe(big(10000, 'u'));
  });

  it('leaves short results and already-stubbed results alone', () => {
    const msgs: Msg[] = [];
    for (let i = 0; i < 10; i++) { msgs.push(...call('list_files', { i }, 'short')); }
    msgs[1].content = '[superseded: a newer read_file result appears later in this conversation]';
    const out = elideOldToolResults(msgs as any, { keepRecentTools: 2 });
    expect(out.every((m, i) => m === msgs[i])).toBe(true);
  });
});

describe('TurnPruner (cache-aware)', () => {
  // estimatePromptTokens ≈ chars/3.5, so a 4000-token window triggers near 7000 chars at 0.5.
  const window = 4000;

  it('does nothing below the trigger — the prompt prefix (and server cache) stays intact', () => {
    const pruner = new TurnPruner(window);
    const msgs = [{ role: 'system', content: 'sys' }, ...call('read_file', { path: 'a.ts' }, 'small')] as any;
    expect(pruner.maybePrune(msgs)).toBeUndefined();
    expect(pruner.passes).toBe(0);
  });

  it('prunes once past the trigger and reports what it saved', () => {
    const pruner = new TurnPruner(window);
    const msgs: Msg[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'fix the bug' }];
    msgs.push(...call('read_file', { path: 'a.ts' }, big(5000, 'a')));
    msgs.push(...call('read_file', { path: 'a.ts' }, big(5000, 'b'))); // supersedes the first
    const pass = pruner.maybePrune(msgs as any)!;
    expect(pass).toBeDefined();
    expect(pass.results).toBe(1);
    expect(pass.savedChars).toBeGreaterThan(4900);
    expect(pass.tokensAfter).toBeLessThan(pass.tokensBefore);
    expect(pass.messages[1].content).toBe('fix the bug');
    expect(pruner.passes).toBe(1);
  });

  it('does not fire again on the next calls unless the turn grows substantially (one cache rebuild per pass)', () => {
    const pruner = new TurnPruner(window);
    let msgs: Msg[] = [{ role: 'system', content: 'sys' }];
    msgs.push(...call('read_file', { path: 'a.ts' }, big(5000, 'a')), ...call('read_file', { path: 'a.ts' }, big(5000, 'b')));
    msgs = pruner.maybePrune(msgs as any)!.messages as any;
    // A few small appends: same prompt region, no rewrite.
    for (let i = 0; i < 3; i++) {
      msgs.push(...call('list_files', { dir: `d${i}` }, 'ok'));
      expect(pruner.maybePrune(msgs as any)).toBeUndefined();
    }
    expect(pruner.passes).toBe(1);
  });

  it('a pass that finds nothing to prune does not count and re-arms higher', () => {
    const pruner = new TurnPruner(window);
    const msgs: Msg[] = [{ role: 'user', content: big(9000, 'u') }]; // big, but nothing prunable
    expect(pruner.maybePrune(msgs as any)).toBeUndefined();
    expect(pruner.passes).toBe(0);
  });

  it('falls back to a sane window when the size is unknown', () => {
    expect(() => new TurnPruner(NaN).maybePrune([] as any)).not.toThrow();
  });
});

describe('agent concurrency vs. server slots', () => {
  it('caps the configured agents to the server slots, and only then', () => {
    expect(effectiveAgentLimit(32, 4)).toBe(4);
    expect(effectiveAgentLimit(2, 4)).toBe(2);
    expect(effectiveAgentLimit(32, undefined)).toBe(32); // remote provider: slots unknown
    expect(effectiveAgentLimit(0, 4)).toBe(1);
    expect(effectiveAgentLimit(100, undefined)).toBe(32);
  });

  it('reads total_slots from a llama.cpp /props body and rejects junk', () => {
    expect(parseServerSlots({ total_slots: 4, default_generation_settings: { n_ctx: 131072 } })).toBe(4);
    expect(parseServerSlots({})).toBeUndefined();
    expect(parseServerSlots({ total_slots: 0 })).toBeUndefined();
    expect(parseServerSlots({ total_slots: '4' })).toBeUndefined();
    expect(parseServerSlots(null)).toBeUndefined();
  });
});
