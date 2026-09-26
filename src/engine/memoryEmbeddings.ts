/** Optional, explicitly configured neural embeddings. No endpoint or credential is logged. */
import { createHash } from 'crypto';

export interface MemoryEmbedder {
  model: string;
  /** Endpoint identity prevents mixing vectors from different servers using the same model name. */
  cacheKey?: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface MemoryEmbeddingOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

const MAX_DIMENSIONS = 16384;
const BATCH_SIZE = 16;
const MAX_INPUTS = 256;
const MAX_TEXT_LENGTH = 8000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Scaled L2 normalization also handles large but finite components without overflow. */
export function normalizeMemoryVector(value: unknown, dimensions?: number): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DIMENSIONS ||
      (dimensions !== undefined && value.length !== dimensions) ||
      value.some(component => typeof component !== 'number' || !Number.isFinite(component))) {
    throw new Error('Invalid memory embedding dimensions or components');
  }
  const scale = value.reduce((largest, component: number) => Math.max(largest, Math.abs(component)), 0);
  if (scale === 0) { throw new Error('Memory embedding has zero magnitude'); }
  const scaled = (value as number[]).map(component => component / scale);
  const norm = Math.sqrt(scaled.reduce((sum, component) => sum + component * component, 0));
  return scaled.map(component => component / norm);
}

function embeddingUrl(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('Invalid memory embedding endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Memory embedding endpoint must be an HTTP(S) base URL without credentials or query parameters');
  }
  const base = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/embeddings$/.test(base) ? base : /\/v\d+$/.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`;
  return url.toString();
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('Memory embedding response exceeds its size limit');
  }
  if (!response.body) { throw new Error('Memory embedding response has no body'); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) { break; }
      size += result.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Memory embedding response exceeds its size limit');
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Memory embedding response is not valid JSON'); }
}

/** Blank model disables embeddings; no automatic model discovery or credential lookup occurs. */
export function createMemoryEmbedder(options: MemoryEmbeddingOptions): MemoryEmbedder | undefined {
  const model = options.model.trim();
  if (!model) { return undefined; }
  if (model.length > 240 || /[\x00-\x1f]/.test(model)) { throw new Error('Invalid memory embedding model'); }
  const endpoint = embeddingUrl(options.endpoint);
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(100, Math.min(30000, options.timeoutMs!)) : 10000;
  const cacheKey = `${model}@${createHash('sha256').update(endpoint).digest('hex').slice(0, 20)}`;
  return {
    model,
    cacheKey,
    async embed(texts: string[]): Promise<number[][]> {
      if (!Array.isArray(texts) || texts.length > MAX_INPUTS ||
          texts.some(value => typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT_LENGTH)) {
        throw new Error('Invalid or excessive memory embedding input');
      }
      if (!texts.length) { return []; }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Memory embedding request timed out'));
        }, timeoutMs);
      });
      const request = async (): Promise<number[][]> => {
        const vectors: number[][] = [];
        let dimensions: number | undefined;
        for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
          if (controller.signal.aborted) { throw new Error('Memory embedding request timed out'); }
          const batch = texts.slice(offset, offset + BATCH_SIZE);
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
            },
            body: JSON.stringify({ model, input: batch, encoding_format: 'float' }),
            signal: controller.signal,
            // A redirected credentialed request should not silently reach a different provider.
            redirect: 'error',
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Memory embedding provider returned HTTP ${response.status}`);
          }
          const payload = await boundedJson(response) as { data?: unknown };
          if (!payload || !Array.isArray(payload.data) || payload.data.length !== batch.length) {
            throw new Error('Memory embedding provider returned an invalid batch');
          }
          const ordered: Array<number[] | undefined> = new Array(batch.length);
          for (const entry of payload.data) {
            if (!entry || typeof entry !== 'object') { throw new Error('Memory embedding provider returned an invalid item'); }
            const { index, embedding } = entry as { index?: unknown; embedding?: unknown };
            if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= batch.length || ordered[index as number]) {
              throw new Error('Memory embedding provider returned invalid batch indices');
            }
            const vector = normalizeMemoryVector(embedding, dimensions);
            dimensions ??= vector.length;
            ordered[index as number] = vector;
          }
          if (ordered.some(vector => !vector)) { throw new Error('Memory embedding provider omitted an item'); }
          vectors.push(...ordered as number[][]);
        }
        return vectors;
      };
      try { return await Promise.race([request(), deadline]); }
      catch (error) {
        controller.abort();
        // Deliberately exclude fetch errors and response text: either may contain credentials.
        if (error instanceof Error && /^Memory embedding (?:request timed out|provider returned|provider omitted|response|has zero|dimensions)/.test(error.message)) {
          throw error;
        }
        throw new Error('Memory embedding request failed or returned invalid vectors');
      } finally { if (timer) { clearTimeout(timer); } }
    },
  };
}
