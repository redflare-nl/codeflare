import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryEmbedder, normalizeMemoryVector } from '../src/engine/memoryEmbeddings';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function response(embeddings: number[][], reversed = false): Response {
  const data = embeddings.map((embedding, index) => ({ index, embedding }));
  return new Response(JSON.stringify({ data: reversed ? data.reverse() : data }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('optional neural memory embeddings', () => {
  it('is disabled for a blank model without validating or contacting any endpoint', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(createMemoryEmbedder({ endpoint: '', model: ' ' })).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['https://api.example.test', 'https://api.example.test/v1/embeddings'],
    ['http://localhost:8001/v1/', 'http://localhost:8001/v1/embeddings'],
    ['https://provider.test/custom/v1/embeddings', 'https://provider.test/custom/v1/embeddings'],
  ])('uses the configured OpenAI-compatible endpoint %s', async (endpoint, expected) => {
    const fetch = vi.fn(async () => response([[3, 4], [5, 0]], true)); vi.stubGlobal('fetch', fetch);
    const embedder = createMemoryEmbedder({ endpoint, model: 'configured-embedding', apiKey: 'private-token' })!;
    const vectors = await embedder.embed(['first', 'second']);
    expect(vectors).toEqual([[0.6, 0.8], [1, 0]]);
    expect(fetch).toHaveBeenCalledWith(expected, expect.objectContaining({
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer private-token' },
    }));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      model: 'configured-embedding', input: ['first', 'second'], encoding_format: 'float',
    });
  });

  it('batches inputs and maintains one vector dimension across batches', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { input } = JSON.parse(init.body as string);
      return response(input.map(() => [1, 2, 3]));
    }); vi.stubGlobal('fetch', fetch);
    const vectors = await createMemoryEmbedder({ endpoint: 'http://localhost:8001', model: 'local-embed' })!
      .embed(Array.from({ length: 35 }, (_, index) => `text ${index}`));
    expect(vectors).toHaveLength(35);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body as string).input.length)).toEqual([16, 16, 3]);
    expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  it('rejects provider responses with invalid dimensions rather than silently mixing vectors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([[1, 0], [1, 0, 0]])));
    await expect(createMemoryEmbedder({ endpoint: 'https://provider.test', model: 'embedding' })!.embed(['a', 'b']))
      .rejects.toThrow(/invalid vectors/);
  });

  it.each([
    { data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [1, 0] }] },
    { data: [{ index: 1, embedding: [1, 0] }] },
    { data: [{ index: 0, embedding: [0, 0] }] },
    { data: [{ index: 0, embedding: ['1', '0'] }] },
    { data: [] },
    null,
  ])('rejects malformed provider payload %#', async payload => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload))));
    await expect(createMemoryEmbedder({ endpoint: 'https://provider.test', model: 'embedding' })!.embed(['a']))
      .rejects.toThrow();
  });

  it('bounds response bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } })));
    await expect(createMemoryEmbedder({ endpoint: 'https://provider.test', model: 'embedding' })!.embed(['a']))
      .rejects.toThrow(/size limit/);
  });

  it('does not leak provider bodies or request errors containing credentials', async () => {
    const client = createMemoryEmbedder({ endpoint: 'https://provider.test', model: 'embedding', apiKey: 'PRIVATE-TOKEN' })!;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('PRIVATE-TOKEN internal error', { status: 401 })));
    await expect(client.embed(['a'])).rejects.toThrow('Memory embedding provider returned HTTP 401');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Request failed https://host/?token=PRIVATE-TOKEN'); }));
    await expect(client.embed(['a'])).rejects.toThrow('Memory embedding request failed or returned invalid vectors');
  });

  it('has a deadline even when a provider does not respond to abort', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal('fetch', fetch);
    const pending = createMemoryEmbedder({ endpoint: 'https://provider.test', model: 'embedding', timeoutMs: 100 })!.embed(['a']);
    const asserted = expect(pending).rejects.toThrow('Memory embedding request timed out');
    await vi.advanceTimersByTimeAsync(100);
    await asserted;
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it.each(['file:///memory', 'https://user:password@host.test', 'https://host.test?token=secret', 'invalid'])
    ('rejects unsuitable endpoints without echoing them: %s', endpoint => {
      expect(() => createMemoryEmbedder({ endpoint, model: 'embedding' })).toThrow(/endpoint/);
    });

  it('separates cache identity for the same model name on different endpoints', () => {
    const a = createMemoryEmbedder({ endpoint: 'https://a.test', model: 'shared-name' })!;
    const b = createMemoryEmbedder({ endpoint: 'https://b.test', model: 'shared-name' })!;
    expect(a.model).toBe(b.model);
    expect(a.cacheKey).not.toBe(b.cacheKey);
    expect(a.cacheKey).not.toContain('https://');
  });

  it('bounds input count and text size before issuing requests', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const client = createMemoryEmbedder({ endpoint: 'https://provider.test', model: 'embedding' })!;
    await expect(client.embed(Array(257).fill('x'))).rejects.toThrow(/input/);
    await expect(client.embed(['x'.repeat(8001)])).rejects.toThrow(/input/);
    await expect(client.embed([''])).rejects.toThrow(/input/);
    expect(await client.embed([])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('memory vector validation', () => {
  it('normalizes finite components, including extremely large finite values', () => {
    expect(normalizeMemoryVector([3, 4])).toEqual([0.6, 0.8]);
    expect(normalizeMemoryVector([1e308, 1e308])[0]).toBeCloseTo(Math.SQRT1_2);
  });
  it.each([[], [0, 0], [NaN, 1], [Infinity, 1], ['1', 2], new Array(16385).fill(1)].map(vector => [vector]))
    ('rejects unusable vectors %#', vector => { expect(() => normalizeMemoryVector(vector)).toThrow(); });
  it('rejects dimension drift', () => { expect(() => normalizeMemoryVector([1, 2], 3)).toThrow(); });
});
