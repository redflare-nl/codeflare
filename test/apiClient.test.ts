import { describe, expect, it } from 'vitest';
import { ApiDeps, discoverSpec, inlineFileRefs, performApiRequest, resolveUrl } from '../src/utils/apiClient';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_B64, 'base64'));
const KEY = 'sk-test-secret-1234567890';

interface Recorded { url: string; init: RequestInit }

/** A fetch stub that records calls and answers from a handler. */
function fakeFetch(handler: (url: string, init: RequestInit, n: number) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fn = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init || {} });
    return handler(url, init || {}, calls.length);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function deps(fetchImpl: typeof fetch, extra: Partial<ApiDeps> = {}): ApiDeps & { saved: Map<string, Uint8Array> } {
  const saved = new Map<string, Uint8Array>();
  return {
    fetchImpl,
    saveFile: async (rel, bytes) => { saved.set(rel, bytes); return { ok: true, rel, bytes: bytes.length }; },
    sleep: async () => { /* instant */ },
    saved,
    ...extra,
  };
}

describe('resolveUrl', () => {
  it('keeps absolute URLs and resolves paths against the base PATH, not the origin', () => {
    expect(resolveUrl('https://x.example.com/a', 'https://api.example.com/v2')).toBe('https://x.example.com/a');
    expect(resolveUrl('/balance', 'https://api.example.com/v2')).toBe('https://api.example.com/v2/balance');
    expect(resolveUrl('balance', 'https://api.example.com/v2/')).toBe('https://api.example.com/v2/balance');
    expect(resolveUrl('/jobs/abc', undefined)).toMatchObject({ error: expect.stringContaining('no known base URL') });
  });
});

describe('performApiRequest — auth + transport', () => {
  it('injects a bearer token, never echoes it, and sends JSON bodies', async () => {
    const f = fakeFetch((url) => json({ ok: true, echo: url }));
    const out = await performApiRequest(
      { url: '/balance', query: { a: 1, b: 'x y' }, body: { hello: 'world' } },
      { scheme: 'bearer', value: KEY }, 'https://api.example.com/v2', deps(f.fn)
    );
    expect(f.calls[0].url).toBe('https://api.example.com/v2/balance?a=1&b=x+y');
    const h = f.calls[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${KEY}`);
    expect(h['Content-Type']).toBe('application/json');
    expect(f.calls[0].init.method).toBe('POST');
    expect(f.calls[0].init.body).toBe('{"hello":"world"}');
    expect(out).toContain('HTTP 200');
    expect(out).toContain('"ok": true');
    expect(out).not.toContain(KEY);
  });

  it('supports header / query / basic schemes and ignores a model-supplied Authorization header', async () => {
    const f = fakeFetch(() => json({}));
    await performApiRequest({ url: 'https://h.example.com/a', headers: { Authorization: 'Bearer forged' } }, { scheme: 'header', name: 'X-API-Key', value: KEY }, undefined, deps(f.fn));
    expect((f.calls[0].init.headers as any)['X-API-Key']).toBe(KEY);
    expect((f.calls[0].init.headers as any).Authorization).toBeUndefined();

    await performApiRequest({ url: 'https://h.example.com/a' }, { scheme: 'query', name: 'key', value: KEY }, undefined, deps(f.fn));
    expect(f.calls[1].url).toBe(`https://h.example.com/a?key=${KEY}`);

    await performApiRequest({ url: 'https://h.example.com/a' }, { scheme: 'basic', value: 'user:pw' }, undefined, deps(f.fn));
    expect((f.calls[2].init.headers as any).Authorization).toBe('Basic ' + Buffer.from('user:pw').toString('base64'));
  });

  it('refuses plain http except to localhost', async () => {
    const f = fakeFetch(() => json({}));
    expect(await performApiRequest({ url: 'http://api.example.com/x' }, undefined, undefined, deps(f.fn))).toContain('Refusing');
    expect(f.calls.length).toBe(0);
    await performApiRequest({ url: 'http://localhost:8080/x' }, undefined, undefined, deps(f.fn));
    expect(f.calls.length).toBe(1);
  });

  it('reports 4xx with the body, a hint, and the secret redacted even from the response', async () => {
    const f = fakeFetch(() => json({ detail: [{ loc: ['body', 'image_size'], msg: 'field required' }], echo: KEY }, 422));
    const out = await performApiRequest({ url: 'https://api.example.com/x', body: {} }, { scheme: 'bearer', value: KEY }, undefined, deps(f.fn));
    expect(out).toContain('HTTP 422');
    expect(out).toContain('field required');
    expect(out).toContain('api_describe');
    expect(out).not.toContain(KEY);
    expect(out).toContain('***REDACTED***');

    const g = fakeFetch(() => json({ detail: 'nope' }, 401));
    expect(await performApiRequest({ url: 'https://api.example.com/x' }, undefined, undefined, deps(g.fn))).toContain('credential was rejected');
  });

  it('surfaces network failures without throwing', async () => {
    const f = { fn: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch };
    expect(await performApiRequest({ url: 'https://api.example.com/x' }, undefined, undefined, deps(f.fn))).toContain('ECONNREFUSED');
  });
});

describe('performApiRequest — files', () => {
  it('writes a binary response to save_to (extension from magic bytes) and asks for save_to otherwise', async () => {
    const f = fakeFetch(() => new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }));
    const d = deps(f.fn);
    const noPath = await performApiRequest({ url: 'https://cdn.example.com/a' }, undefined, undefined, d);
    expect(noPath).toContain('Binary response');
    expect(noPath).toContain('save_to');
    const out = await performApiRequest({ url: 'https://cdn.example.com/a', save_to: 'assets/hero' }, undefined, undefined, d);
    expect(out).toContain('Saved file to "assets/hero.png"');
    expect(d.saved.get('assets/hero.png')).toEqual(PNG_BYTES);
  });

  it('extracts base64 images from JSON into save_images_dir and replaces them in the returned JSON', async () => {
    const f = fakeFetch(() => json({ usage: { generations: 1 }, images: [{ type: 'base64', base64: PNG_B64 }, { type: 'base64', base64: PNG_B64 }] }));
    const d = deps(f.fn);
    const out = await performApiRequest({ url: 'https://api.example.com/gen', body: { x: 1 }, save_images_dir: 'assets/walk', save_images_prefix: 'walk' }, undefined, undefined, d);
    expect(out).toContain('Saved image to "assets/walk/walk_0.png"');
    expect(out).toContain('Saved image to "assets/walk/walk_1.png"');
    expect(out).toContain('"base64": "<saved to assets/walk/walk_0.png>"');
    expect(out).not.toContain(PNG_B64);
    expect(d.saved.size).toBe(2);

    // Without a destination the images are summarized, never dumped.
    const out2 = await performApiRequest({ url: 'https://api.example.com/gen', body: { x: 1 } }, undefined, undefined, deps(f.fn));
    expect(out2).toContain('contains 2 embedded image(s)');
    expect(out2).not.toContain(PNG_B64);

    // A single image goes to save_to as-is.
    const g = fakeFetch(() => json({ image: { type: 'base64', base64: PNG_B64 } }));
    const d2 = deps(g.fn);
    const out3 = await performApiRequest({ url: 'https://api.example.com/gen', body: {}, save_to: 'assets/one.png' }, undefined, undefined, d2);
    expect(out3).toContain('Saved image to "assets/one.png"');
  });

  it('reports a refused save (policy) instead of pretending', async () => {
    const f = fakeFetch(() => json({ image: PNG_B64 }));
    const d = deps(f.fn, { saveFile: async () => ({ ok: false, error: 'Path is protected by policy' }) });
    const out = await performApiRequest({ url: 'https://api.example.com/gen', body: {}, save_to: 'x.png' }, undefined, undefined, d);
    expect(out).toContain('Could not save image: Path is protected by policy');
    expect(out).toContain('NOT saved');
  });

  it('inlines {"$file"} and {"$dataUrl"} body references from the workspace', async () => {
    const readFile = async (rel: string) => rel === 'ref.png' ? PNG_BYTES : { error: 'no such file' };
    const r = await inlineFileRefs({ reference_image: { type: 'base64', base64: { $file: 'ref.png' } }, list: [{ $dataUrl: 'ref.png' }] }, { saveFile: async () => ({ ok: false, error: '' }), readFile });
    expect('body' in r && r.body.reference_image.base64).toBe(PNG_B64);
    expect('body' in r && r.body.list[0]).toBe(`data:image/png;base64,${PNG_B64}`);
    const bad = await inlineFileRefs({ a: { $file: 'missing.png' } }, { saveFile: async () => ({ ok: false, error: '' }), readFile });
    expect('error' in bad && bad.error).toContain('missing.png');

    const f = fakeFetch(() => json({ ok: 1 }));
    await performApiRequest({ url: 'https://api.example.com/x', body: { img: { $file: 'ref.png' } } }, undefined, undefined, deps(f.fn, { readFile }));
    expect(JSON.parse(String(f.calls[0].init.body)).img).toBe(PNG_B64);
  });
});

describe('performApiRequest — polling', () => {
  it('re-GETs until the status field is terminal, then returns the final body', async () => {
    const f = fakeFetch((_u, _i, n) => json(n < 3 ? { status: 'processing', id: 'j1' } : { status: 'completed', id: 'j1', last_response: { images: [{ base64: PNG_B64 }] } }));
    const d = deps(f.fn);
    const out = await performApiRequest(
      { url: 'https://api.example.com/jobs/j1', poll: { interval_ms: 500, max_wait_ms: 10000 }, save_images_dir: 'assets/job' },
      undefined, undefined, d
    );
    expect(f.calls.length).toBe(3);
    expect(out).toContain('(after 2 poll(s))');
    expect(out).toContain('"status": "completed"');
    expect(out).toContain('Saved image to "assets/job/last_response_images_0.png"');
  });

  it('stops at max_wait_ms with a clear "still running" report', async () => {
    let t = 0;
    const f = fakeFetch(() => json({ status: 'processing' }));
    const d = deps(f.fn, { now: () => t, sleep: async (ms) => { t += ms; } });
    const out = await performApiRequest({ url: 'https://api.example.com/jobs/j1', poll: { interval_ms: 1000, max_wait_ms: 3500 } }, undefined, undefined, d);
    expect(out).toContain('Still not finished');
    expect(out).toContain('"status" = "processing"');
    expect(f.calls.length).toBeGreaterThanOrEqual(3);
    expect(f.calls.length).toBeLessThanOrEqual(4);
  });

  it('honours a custom status field and done values', async () => {
    const f = fakeFetch((_u, _i, n) => json({ data: { state: n < 2 ? 'RUNNING' : 'OK' } }));
    const out = await performApiRequest(
      { url: 'https://api.example.com/j', poll: { status_field: 'data.state', done_values: ['ok', 'ko'], interval_ms: 500 } },
      undefined, undefined, deps(f.fn)
    );
    expect(f.calls.length).toBe(2);
    expect(out).toContain('"state": "OK"');
  });
});

describe('discoverSpec', () => {
  const v1 = { openapi: '3.0.0', info: { title: 'Sprite API', version: '1' }, servers: [{ url: '/v1' }], paths: { '/a': { get: {} } } };
  const v2 = {
    openapi: '3.1.0', info: { title: 'Sprite API', version: '2' }, servers: [{ url: '/v2' }],
    components: { securitySchemes: { HTTPBearer: { type: 'http', scheme: 'bearer' } } },
    paths: { '/a': { get: {}, post: {} }, '/b': { post: {} } },
  };

  it('probes conventional locations from a site URL and picks the richest spec', async () => {
    const f = fakeFetch((url) => {
      if (url === 'https://api.sprite.test/v1/openapi.json') { return json(v1); }
      if (url === 'https://api.sprite.test/v2/openapi.json') { return json(v2); }
      if (url === 'https://sprite.test/') { return new Response('<html><a href="/pricing">x</a></html>', { headers: { 'content-type': 'text/html' } }); }
      return new Response('{"detail":"Not Found"}', { status: 404, headers: { 'content-type': 'application/json' } });
    });
    const d = await discoverSpec('sprite.test', { fetchImpl: f.fn, concurrency: 8 });
    expect('spec' in d).toBe(true);
    if ('spec' in d) {
      expect(d.specUrl).toBe('https://api.sprite.test/v2/openapi.json');
      expect(d.baseUrl).toBe('https://api.sprite.test/v2');
      expect(d.endpointCount).toBe(3);
      expect(d.auth.scheme).toBe('bearer');
      expect(d.alternatives.map(a => a.specUrl)).toEqual(['https://api.sprite.test/v1/openapi.json']);
    }
  });

  it('follows the spec link in llms.txt and accepts a direct spec URL', async () => {
    const f = fakeFetch((url) => {
      if (url === 'https://docs.other.test/llms.txt') { return new Response('See [spec](https://cdn.other.test/schema/openapi.json)', { headers: { 'content-type': 'text/plain' } }); }
      if (url === 'https://cdn.other.test/schema/openapi.json') { return json(v2); }
      return new Response('nope', { status: 404 });
    });
    const d = await discoverSpec('https://docs.other.test', { fetchImpl: f.fn });
    expect('spec' in d && d.specUrl).toBe('https://cdn.other.test/schema/openapi.json');

    const direct = await discoverSpec('https://cdn.other.test/schema/openapi.json', { fetchImpl: f.fn });
    expect('spec' in direct && direct.tried).toBeGreaterThanOrEqual(1);
  });

  it('returns tried locations and next-step hints when nothing parses', async () => {
    const f = fakeFetch(() => new Response('<html>marketing</html>', { headers: { 'content-type': 'text/html' } }));
    const d = await discoverSpec('https://nothing.test', { fetchImpl: f.fn });
    expect('hints' in d).toBe(true);
    if ('hints' in d) {
      expect(d.tried.length).toBeGreaterThan(5);
      expect(d.hints.join(' ')).toContain('web_search');
    }
  });
});
