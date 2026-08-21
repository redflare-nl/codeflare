import { getApiKey } from './secrets';
import { getConfig, setDetectedModel } from './config';
import { log } from './logger';

/**
 * Detects the model's context window (n_ctx) from the server. llama.cpp exposes
 * it via /props; other backends may not, in which case it stays undefined and
 * the configured maxTokens is used as-is.
 */

let contextSize: number | undefined;

export function getContextSize(): number | undefined {
  return contextSize;
}

/**
 * Learn the context window from a source other than /props — e.g. parsed out
 * of a llama.cpp exceed_context_size error body when /props was unreachable.
 */
export function setContextSize(n: number): void {
  if (typeof n === 'number' && n > 0 && n !== contextSize) {
    contextSize = n;
    log(`Context window learned from server response: ${n} tokens`);
  }
}

export async function detectContextSize(endpoint: string): Promise<void> {
  // Anthropic has no /props probe; its current models are all ≥200k context.
  // Use a safe known value so the context meter and output budget work.
  if (getConfig().provider === 'anthropic') {
    contextSize = 200000;
    log('Context window: 200000 tokens (Anthropic)');
    return;
  }

  const base = endpoint.replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  const key = getApiKey();
  if (key) { headers['Authorization'] = `Bearer ${key}`; }

  try {
    const resp = await fetch(`${base}/props`, { headers, signal: AbortSignal.timeout(4000) });
    if (!resp.ok) { return; }
    const data: any = await resp.json();
    const n = data?.default_generation_settings?.n_ctx ?? data?.n_ctx;
    if (typeof n === 'number' && n > 0) {
      contextSize = n;
      log(`Detected model context window: ${n} tokens`);
    }
  } catch {
    // Not a llama.cpp server, or unreachable — leave undefined.
  }
}

/**
 * Discover the served model's name from the server's /v1/models list, so the
 * user never has to type it. Scoped to the LOCAL provider: a local
 * OpenAI-compatible server (VLLM, llama.cpp, Ollama) typically serves ONE model,
 * so its id is unambiguous; OpenAI and Anthropic list many models, so their
 * configured default stands instead. The discovered value feeds config's model
 * resolution (used only when the model setting is left blank). Failure leaves
 * the previously discovered value untouched — a transient blip doesn't wipe it.
 */
export async function detectModel(endpoint: string): Promise<void> {
  const config = getConfig();
  if (!config.autoDetectModel || config.provider !== 'local') { return; }

  const base = endpoint.replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  const key = getApiKey();
  if (key) { headers['Authorization'] = `Bearer ${key}`; }

  try {
    const resp = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(4000) });
    if (!resp.ok) { return; }
    const data: any = await resp.json();
    const list: any[] = Array.isArray(data?.data) ? data.data : [];
    const id = list.map(m => m?.id).find(s => typeof s === 'string' && s.trim());
    if (id) {
      setDetectedModel(id);
      log(`Discovered model from server: ${id}${list.length > 1 ? ` (+${list.length - 1} more listed)` : ''}`);
    }
  } catch {
    // Unreachable or not OpenAI-compatible — keep whatever we had.
  }
}
