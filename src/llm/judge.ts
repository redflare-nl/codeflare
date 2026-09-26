import { CodeFlareConfig, PROVIDER_DEFAULTS, Provider, resolveModel } from '../utils/config';

/**
 * The independent judge: a second model that reviews the worker's output.
 *
 * Self-evaluation by the same weights shares the same blind spots — a model
 * that misread the request will confirm its own misreading. When the user
 * points codeflare.judge* at a different provider or model, requirement review,
 * Prove It, Break My Solution and memory reflection run on that model instead.
 *
 * Pure: no vscode, no network. The one rule enforced here is honesty — a judge
 * that resolves to exactly the worker's provider/endpoint/model is NOT
 * independent and is reported as absent, so nothing upstream can claim
 * independence the configuration does not provide.
 */

export interface ClientTarget {
  provider: Provider;
  endpoint: string;
  model: string;
}

export interface JudgeResolution {
  target: ClientTarget;
  /** Short human label for UI/log lines and metrics, e.g. "openai:gpt-4o". */
  label: string;
}

type JudgeConfig = Pick<CodeFlareConfig, 'provider' | 'endpoint' | 'model' | 'judgeProvider' | 'judgeEndpoint' | 'judgeModel'>;

const trimSlash = (url: string) => (url || '').trim().replace(/\/+$/, '');

/**
 * Resolve the configured judge, or undefined when there is none — including
 * when the settings resolve to the very model that did the work.
 */
export function resolveJudgeTarget(cfg: JudgeConfig): JudgeResolution | undefined {
  const provider = cfg.judgeProvider;
  if (provider !== 'local' && provider !== 'openai' && provider !== 'anthropic') { return undefined; }
  const defaults = PROVIDER_DEFAULTS[provider];
  const endpoint = trimSlash(cfg.judgeEndpoint) || defaults.endpoint;
  // A blank judge model follows the provider's normal resolution (explicit →
  // discovered → default). For a local judge on ANOTHER server the discovered
  // name belongs to the worker's server, so users must set judgeModel then.
  const model = resolveModel(provider, cfg.judgeModel || '', defaults.model);
  const target: ClientTarget = { provider, endpoint, model };
  if (provider === cfg.provider && endpoint === trimSlash(cfg.endpoint) && model === cfg.model) {
    return undefined; // Same model reviewing itself is not a judge.
  }
  return { target, label: `${provider}:${model}` };
}
