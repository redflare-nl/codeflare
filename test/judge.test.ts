import { describe, expect, it } from 'vitest';
import { resolveJudgeTarget } from '../src/llm/judge';
import { PROVIDER_DEFAULTS, setDetectedModel } from '../src/utils/config';

/**
 * The one property that matters: a "judge" that is the worker itself must be
 * reported as absent. Everything else is plumbing around provider defaults.
 */

const worker = { provider: 'local' as const, endpoint: 'http://localhost:8001', model: 'Qwen3.8-27B' };
const cfg = (judge: Partial<{ judgeProvider: string; judgeEndpoint: string; judgeModel: string }>) => ({
  ...worker,
  judgeProvider: (judge.judgeProvider ?? '') as '' | 'local' | 'openai' | 'anthropic',
  judgeEndpoint: judge.judgeEndpoint ?? '',
  judgeModel: judge.judgeModel ?? '',
});

describe('resolveJudgeTarget', () => {
  it('returns undefined when no judge provider is configured', () => {
    expect(resolveJudgeTarget(cfg({}))).toBeUndefined();
    expect(resolveJudgeTarget(cfg({ judgeProvider: 'nonsense' }))).toBeUndefined();
  });

  it('resolves another provider with its defaults', () => {
    const r = resolveJudgeTarget(cfg({ judgeProvider: 'openai' }))!;
    expect(r.target).toEqual({ provider: 'openai', endpoint: PROVIDER_DEFAULTS.openai.endpoint, model: PROVIDER_DEFAULTS.openai.model });
    expect(r.label).toBe(`openai:${PROVIDER_DEFAULTS.openai.model}`);
  });

  it('honours an explicit judge endpoint and model, trimming trailing slashes', () => {
    const r = resolveJudgeTarget(cfg({ judgeProvider: 'local', judgeEndpoint: 'http://localhost:8002/', judgeModel: 'Llama-3.3-70B' }))!;
    expect(r.target).toEqual({ provider: 'local', endpoint: 'http://localhost:8002', model: 'Llama-3.3-70B' });
  });

  it('treats a judge identical to the worker as NO judge', () => {
    setDetectedModel('');
    expect(resolveJudgeTarget(cfg({ judgeProvider: 'local', judgeEndpoint: 'http://localhost:8001', judgeModel: 'Qwen3.8-27B' }))).toBeUndefined();
    // Trailing-slash spelling of the same endpoint is still the same endpoint.
    expect(resolveJudgeTarget(cfg({ judgeProvider: 'local', judgeEndpoint: 'http://localhost:8001/', judgeModel: 'Qwen3.8-27B' }))).toBeUndefined();
  });

  it('a local judge with a blank model follows discovery — which is the worker when on the same server', () => {
    setDetectedModel('Qwen3.8-27B');
    try {
      expect(resolveJudgeTarget(cfg({ judgeProvider: 'local' }))).toBeUndefined();
      // A different model on the same server IS independent.
      const r = resolveJudgeTarget(cfg({ judgeProvider: 'local', judgeModel: 'Other-Model' }))!;
      expect(r.target.model).toBe('Other-Model');
    } finally { setDetectedModel(''); }
  });

  it('same provider but another endpoint counts as independent', () => {
    const r = resolveJudgeTarget(cfg({ judgeProvider: 'local', judgeEndpoint: 'http://gpu-box:8001', judgeModel: 'Qwen3.8-27B' }));
    expect(r?.target.endpoint).toBe('http://gpu-box:8001');
  });
});
