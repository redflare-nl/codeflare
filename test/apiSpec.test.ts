import { describe, expect, it } from 'vitest';
import {
  authInfo, compactJson, describeOperation, detectFormat, extractEmbeddedImages, findOperationPath,
  getPath, listEndpoints, parseSpec, redactSecrets, renderEndpointList, specBaseUrl, specLinksInText,
  specUrlCandidates, stemFromJsonPath,
} from '../src/utils/apiSpec';

// 1×1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Sprite API', version: '2.0' },
  servers: [{ url: '/v2' }],
  components: {
    securitySchemes: { HTTPBearer: { type: 'http', scheme: 'bearer' } },
    schemas: {
      ImageSize: {
        type: 'object', required: ['width', 'height'],
        properties: { width: { type: 'integer', minimum: 16, maximum: 256 }, height: { type: 'integer' } },
      },
      Base64Image: {
        type: 'object', required: ['type', 'base64'],
        properties: { type: { type: 'string', enum: ['base64'] }, base64: { type: 'string', description: 'Raw base64' } },
      },
      AnimateRequest: {
        type: 'object', required: ['description', 'image_size', 'reference_image'],
        properties: {
          description: { type: 'string', description: 'Character description' },
          action: { type: 'string', default: 'walk' },
          view: { type: 'string', enum: ['side', 'low top-down', 'high top-down'] },
          direction: { anyOf: [{ type: 'string', enum: ['north', 'south'] }, { type: 'null' }] },
          n_frames: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Frames' },
          image_size: { $ref: '#/components/schemas/ImageSize' },
          reference_image: { $ref: '#/components/schemas/Base64Image' },
          init_images: { type: 'array', items: { $ref: '#/components/schemas/Base64Image' } },
          self: { $ref: '#/components/schemas/AnimateRequest' },
        },
      },
      AnimateResponse: {
        type: 'object',
        properties: { images: { type: 'array', items: { $ref: '#/components/schemas/Base64Image' } }, usage: { type: 'object' } },
      },
    },
  },
  paths: {
    '/animate-with-text': {
      post: {
        tags: ['Animate'], summary: 'Animate with text', description: 'Creates a pixel art animation.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AnimateRequest' } } } },
        responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/AnimateResponse' } } } } },
      },
    },
    '/balance': { get: { tags: ['Account'], summary: 'Get balance', responses: { '200': { content: { 'application/json': { schema: { type: 'object', properties: { credits: { type: 'number' } } } } } } } } },
    '/jobs/{job_id}': {
      get: {
        tags: ['Jobs'], summary: 'Job status', deprecated: true,
        parameters: [{ name: 'job_id', in: 'path', required: true, schema: { type: 'string' }, description: 'The job' }],
        responses: { '200': { description: 'ok' } },
      },
      delete: { tags: ['Jobs'], summary: 'Cancel job', responses: { '200': { description: 'ok' } } },
    },
  },
};
const specText = JSON.stringify(SPEC);

describe('parseSpec / specBaseUrl / authInfo', () => {
  it('accepts OpenAPI and Swagger JSON, rejects everything else', () => {
    expect(parseSpec(specText)).not.toBeNull();
    expect(parseSpec(JSON.stringify({ swagger: '2.0', paths: {} }))).not.toBeNull();
    expect(parseSpec(JSON.stringify({ paths: {} }))).toBeNull();
    expect(parseSpec('<html>')).toBeNull();
    expect(parseSpec(JSON.stringify({ openapi: '3.0.0' }))).toBeNull();
  });

  it('resolves a relative servers[0].url against the spec origin', () => {
    const spec = parseSpec(specText)!;
    expect(specBaseUrl(spec, 'https://api.example.com/v2/openapi.json')).toBe('https://api.example.com/v2');
    expect(specBaseUrl({ ...spec, servers: [{ url: 'https://other.example.com/api/' }] }, 'https://api.example.com/openapi.json')).toBe('https://other.example.com/api');
    expect(specBaseUrl({ swagger: '2.0', host: 'h.example.com', basePath: '/v1', paths: {} }, 'https://h.example.com/swagger.json')).toBe('https://h.example.com/v1');
    expect(specBaseUrl({ openapi: '3', paths: {} }, 'https://x.example.com/docs/openapi.json')).toBe('https://x.example.com/docs');
  });

  it('reads the auth scheme', () => {
    expect(authInfo(parseSpec(specText)!).scheme).toBe('bearer');
    expect(authInfo({ openapi: '3', paths: {}, components: { securitySchemes: { k: { type: 'apiKey', in: 'header', name: 'X-Key' } } } }))
      .toMatchObject({ scheme: 'header', name: 'X-Key' });
    expect(authInfo({ openapi: '3', paths: {}, components: { securitySchemes: { k: { type: 'apiKey', in: 'query', name: 'key' } } } }))
      .toMatchObject({ scheme: 'query', name: 'key' });
    expect(authInfo({ openapi: '3', paths: {} }).scheme).toBe('none');
  });
});

describe('endpoint index', () => {
  const spec = parseSpec(specText)!;

  it('lists every method of every path with its tag', () => {
    const eps = listEndpoints(spec);
    expect(eps.map(e => `${e.method} ${e.path}`)).toEqual([
      'POST /animate-with-text', 'GET /balance', 'GET /jobs/{job_id}', 'DELETE /jobs/{job_id}',
    ]);
    expect(eps[2].deprecated).toBe(true);
  });

  it('renders grouped, filters by keyword, and reports truncation', () => {
    const all = renderEndpointList(spec);
    expect(all).toContain('4 endpoint(s)');
    expect(all).toContain('## Animate');
    expect(all).toContain('POST   /animate-with-text — Animate with text');
    expect(all).toContain('[deprecated]');

    const filtered = renderEndpointList(spec, { filter: 'job' });
    expect(filtered).toContain('2 endpoint(s) matching "job"');
    expect(filtered).not.toContain('/balance');

    // Description text counts as a match, not just the summary.
    expect(renderEndpointList(spec, { filter: 'pixel art' })).toContain('/animate-with-text');
    expect(renderEndpointList(spec, { filter: 'nothing-here' })).toContain('No endpoints match');

    const big = { ...spec, paths: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`/p${i}`, { get: { summary: `op ${i}` } }])) };
    const t = renderEndpointList(big, { max: 10 });
    expect(t).toContain('… 20 more not shown');
  });

  it('finds an operation path even when given the server prefix', () => {
    expect(findOperationPath(spec, '/animate-with-text')).toBe('/animate-with-text');
    expect(findOperationPath(spec, 'animate-with-text')).toBe('/animate-with-text');
    expect(findOperationPath(spec, '/v2/animate-with-text')).toBe('/animate-with-text');
    expect(findOperationPath(spec, '/nope')).toBeUndefined();
  });
});

describe('describeOperation', () => {
  const spec = parseSpec(specText)!;

  it('shows body fields with type, REQUIRED, enums, defaults, nested $ref and response shape', () => {
    const d = describeOperation(spec, 'POST', '/animate-with-text')!;
    expect(d).toContain('POST /animate-with-text — Animate with text');
    expect(d).toContain('Request body (application/json) REQUIRED:');
    expect(d).toContain('- description: string — REQUIRED — Character description');
    expect(d).toContain('- action: string — default "walk"');
    expect(d).toContain('- view: enum — one of "side" | "low top-down" | "high top-down"');
    expect(d).toContain('- direction: enum | null — one of "north" | "south"');
    expect(d).toContain('- n_frames: integer | null');
    expect(d).toContain('- image_size: ImageSize — REQUIRED');
    expect(d).toContain('    - width: integer — REQUIRED — range 16..256');
    expect(d).toContain('- reference_image: Base64Image — REQUIRED');
    expect(d).toContain('    - type: enum — REQUIRED — one of "base64"');
    expect(d).toContain('- init_images: array of Base64Image');
    // Recursive schema terminates.
    expect(d).toContain('- self: AnimateRequest');
    expect(d).toContain('Response (application/json):');
    expect(d).toContain('- images: array of Base64Image');
  });

  it('shows path parameters and returns null for unknown operations', () => {
    const d = describeOperation(spec, 'get', '/jobs/{job_id}')!;
    expect(d).toContain('DEPRECATED');
    expect(d).toContain('- job_id (path): string — REQUIRED — The job');
    expect(describeOperation(spec, 'put', '/jobs/{job_id}')).toBeNull();
    expect(describeOperation(spec, 'get', '/missing')).toBeNull();
  });
});

describe('secrets, binary detection, embedded images', () => {
  it('redacts raw and url-encoded secrets, ignores short ones', () => {
    const key = 'bb266454-f11a-4dd7-ac68';
    expect(redactSecrets(`Authorization: Bearer ${key} ok`, [key])).toBe('Authorization: Bearer ***REDACTED*** ok');
    expect(redactSecrets('a b c', ['b'])).toBe('a b c');
    expect(redactSecrets('x=a%20b%2Fcdefgh', ['a b/cdefgh'])).toContain('***REDACTED***');
  });

  it('detects formats from magic bytes', () => {
    expect(detectFormat(new Uint8Array(Buffer.from(PNG_B64, 'base64')))).toBe('png');
    expect(detectFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]))).toBe('gif');
    expect(detectFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('jpg');
    expect(detectFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('zip');
    expect(detectFormat(new TextEncoder().encode('{"json": true, "x": 1}'))).toBeNull();
  });

  it('finds base64 images anywhere in a JSON response and can replace them', () => {
    const json = {
      usage: { type: 'usd', usd: 0.01 },
      images: [{ type: 'base64', base64: PNG_B64 }, { type: 'base64', base64: `data:image/png;base64,${PNG_B64}` }],
      note: 'a'.repeat(100), // long but not an image
    };
    const found = extractEmbeddedImages(json);
    expect(found.map(f => f.jsonPath)).toEqual(['images[0].base64', 'images[1].base64']);
    expect(found[0].format).toBe('png');
    found[0].replace('<saved to assets/a.png>');
    expect(json.images[0].base64).toBe('<saved to assets/a.png>');
    expect(stemFromJsonPath('images[0].base64', 0)).toBe('images_0');
    expect(stemFromJsonPath('result.frames[3].data', 3)).toBe('result_frames_3');
    expect(stemFromJsonPath('', 7)).toBe('image_7');
  });

  it('compactJson summarizes long strings and truncates; getPath reads dotted paths', () => {
    const t = compactJson({ a: 'x'.repeat(1000), b: [1, 2] }, 8000, 300);
    expect(t).toContain('<string of 1000 chars');
    expect(compactJson({ a: 'y'.repeat(100) }, 500).length).toBeLessThan(700);
    expect(getPath({ data: { status: 'done' } }, 'data.status')).toBe('done');
    expect(getPath({ jobs: [{ state: 'x' }] }, 'jobs[0].state')).toBe('x');
    expect(getPath({}, 'a.b.c')).toBeUndefined();
  });
});

describe('discovery candidates', () => {
  it('tries the given base first, then api.<domain> conventions', () => {
    const c = specUrlCandidates('https://api.pixellab.ai/v2');
    expect(c[0]).toBe('https://api.pixellab.ai/v2/openapi.json');
    expect(c).toContain('https://api.pixellab.ai/v1/openapi.json');
    expect(c).toContain('https://api.pixellab.ai/openapi.json');
    expect(c.some(u => u.startsWith('https://api.api.'))).toBe(false);

    const site = specUrlCandidates('pixellab.ai');
    expect(site[0]).toBe('https://pixellab.ai/openapi.json');
    expect(site).toContain('https://api.pixellab.ai/v2/openapi.json');
    expect(specUrlCandidates('::not a url::')).toEqual([]);
  });

  it('strips a docs suffix from the base and finds spec links in text', () => {
    expect(specUrlCandidates('https://api.example.com/v1/docs')[0]).toBe('https://api.example.com/v1/openapi.json');
    const links = specLinksInText(
      '- [OpenAPI spec](https://api.pixellab.ai/v2/openapi.json): machine-readable\n<a href="/swagger.json">s</a> <img src="/logo.png">',
      'https://pixellab.ai/docs'
    );
    expect(links).toContain('https://api.pixellab.ai/v2/openapi.json');
    expect(links).toContain('https://pixellab.ai/swagger.json');
    expect(links.some(l => l.endsWith('.png'))).toBe(false);
  });
});
