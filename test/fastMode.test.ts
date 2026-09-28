import { describe, expect, it } from 'vitest';
import { anthropicSupportsEffort, fastModeParams, openaiIsReasoningModel } from '../src/llm/fastMode';

describe('fast mode request shaping', () => {
  it('adds nothing when fast mode is off', () => {
    expect(fastModeParams('local', 'qwen3', false)).toEqual({});
    expect(fastModeParams('openai', 'o3', false)).toEqual({});
    expect(fastModeParams('anthropic', 'claude-opus-5', false)).toEqual({});
  });

  it('turns template thinking off for local servers', () => {
    expect(fastModeParams('local', 'Qwen3-32B', true)).toEqual({
      chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'low',
    });
  });

  it('sends reasoning_effort only to OpenAI reasoning models', () => {
    expect(fastModeParams('openai', 'o4-mini', true)).toEqual({ reasoning_effort: 'low' });
    expect(fastModeParams('openai', 'gpt-5.1', true)).toEqual({ reasoning_effort: 'low' });
    expect(fastModeParams('openai', 'gpt-4o', true)).toEqual({});
    expect(openaiIsReasoningModel('gpt-4.1')).toBe(false);
  });

  it('sends low effort only to Anthropic models that accept it', () => {
    expect(fastModeParams('anthropic', 'claude-opus-5', true)).toEqual({ output_config: { effort: 'low' } });
    for (const m of ['claude-opus-4-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-opus-5-5']) {
      expect(anthropicSupportsEffort(m), m).toBe(true);
    }
    for (const m of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-opus-4-1', 'claude-3-7-sonnet-latest']) {
      expect(anthropicSupportsEffort(m), m).toBe(false);
    }
  });
});
