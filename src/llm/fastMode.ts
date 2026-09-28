// Pure, dependency-free request shaping for fast mode (codeflare.fastMode).
// Fast mode asks the model to reason less per call: each provider gets the
// switch it actually understands, and a provider/model that would REJECT an
// unknown parameter gets nothing, so turning fast mode on can never break a call.

import type { Provider } from '../utils/config';

/**
 * Anthropic models that accept `output_config.effort`: Opus 4.5+, and the 4.6+
 * generation of Sonnet/Opus plus Fable/Mythos. Haiku and Sonnet 4.5 reject it.
 */
export function anthropicSupportsEffort(model: string): boolean {
  const m = /claude-(opus|sonnet|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(model.toLowerCase());
  if (!m) { return false; }
  const family = m[1];
  const major = Number(m[2]);
  const minor = m[3] ? Number(m[3]) : 0;
  if (family === 'fable' || family === 'mythos') { return true; }
  if (major > 4) { return true; }
  if (major < 4) { return false; }
  return family === 'opus' ? minor >= 5 : minor >= 6;
}

/** OpenAI reasoning models (o-series, GPT-5 family) — the only ones taking `reasoning_effort`. */
export function openaiIsReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model.trim());
}

/**
 * Extra request-body fields that make the call reason less. `{}` when fast mode
 * is off or the target model has no safe switch.
 *
 * - local: `chat_template_kwargs.enable_thinking=false` turns off <think> for
 *   Qwen3-style templates (vLLM, llama.cpp --jinja); `reasoning_effort` covers
 *   gpt-oss-style models. Servers and templates that don't know them ignore them.
 * - openai: `reasoning_effort: 'low'` on reasoning models only — OpenAI rejects
 *   the parameter on non-reasoning models.
 * - anthropic: `output_config.effort: 'low'` where supported. Thinking itself is
 *   left alone: newer models reject disabling it; effort is the control.
 */
export function fastModeParams(provider: Provider, model: string, fastMode: boolean): Record<string, unknown> {
  if (!fastMode) { return {}; }
  switch (provider) {
    case 'local':
      return { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'low' };
    case 'openai':
      return openaiIsReasoningModel(model) ? { reasoning_effort: 'low' } : {};
    case 'anthropic':
      return anthropicSupportsEffort(model) ? { output_config: { effort: 'low' } } : {};
  }
  return {};
}
