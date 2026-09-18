/**
 * Live end-to-end check of the external-API layer against PixelLab — the same
 * pure modules the api_* tools call, minus the vscode file layer (replaced by
 * a temp dir). Runs only when a key is provided:
 *
 *   PIXELLAB_API_KEY=... npx vitest run test/pixellab.e2e.test.ts
 *
 * Optional: PIXELLAB_OUT=<dir> to keep the generated sprites. Costs a few
 * subscription generations (one still image + one 4-frame animation + one
 * character with 8 rotations).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { ApiDeps, DiscoveredSpec, discoverSpec, performApiRequest, renderDiscovery } from '../src/utils/apiClient';
import { describeOperation, detectFormat, renderEndpointList } from '../src/utils/apiSpec';

const KEY = process.env.PIXELLAB_API_KEY || '';
const OUT = process.env.PIXELLAB_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'codeflare-pixellab-'));

const auth = { scheme: 'bearer' as const, value: KEY };
const deps: ApiDeps = {
  saveFile: async (rel, bytes) => {
    const abs = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    return { ok: true, rel, bytes: bytes.length };
  },
  readFile: async (rel) => {
    try { return new Uint8Array(fs.readFileSync(path.join(OUT, rel))); } catch (e: any) { return { error: e.message }; }
  },
  onProgress: m => console.log('  …', m),
};

describe.skipIf(!KEY)('PixelLab end-to-end (live API)', () => {
  let d: DiscoveredSpec;

  it('discovers the v2 spec from the bare site name and reads its auth scheme', async () => {
    const r = await discoverSpec('pixellab.ai');
    expect('spec' in r).toBe(true);
    d = r as DiscoveredSpec;
    console.log(renderDiscovery(d, renderEndpointList(d.spec, { filter: 'animate' })));
    expect(d.specUrl).toBe('https://api.pixellab.ai/v2/openapi.json');
    expect(d.baseUrl).toBe('https://api.pixellab.ai/v2');
    expect(d.auth.scheme).toBe('bearer');
    expect(d.endpointCount).toBeGreaterThan(50);
  }, 60000);

  it('describes the animate operation compactly (required fields + enums)', () => {
    const text = describeOperation(d.spec, 'post', '/animate-with-text')!;
    console.log(text);
    expect(text).toContain('reference_image');
    expect(text).toContain('REQUIRED');
    expect(text).toContain('"side"');
    expect(text.length).toBeLessThan(9100);
  });

  it('GET /balance with the injected key (and never echoes the key)', async () => {
    const out = await performApiRequest({ url: '/balance' }, auth, d.baseUrl, deps);
    console.log(out);
    expect(out).toContain('HTTP 200');
    expect(out).not.toContain(KEY);
  }, 30000);

  it('generates a character sprite and saves the PNG from the JSON response', async () => {
    const out = await performApiRequest({
      url: '/create-image-pixflux',
      body: {
        description: 'small knight character with sword and shield, side view, facing east, transparent background',
        image_size: { width: 64, height: 64 },
        no_background: true,
        view: 'side',
        direction: 'east',
      },
      save_to: 'assets/knight.png',
      timeout_ms: 120000,
    }, auth, d.baseUrl, deps);
    console.log(out);
    expect(out).toContain('HTTP 200');
    expect(out).toContain('Saved image to "assets/knight.png"');
    const bytes = fs.readFileSync(path.join(OUT, 'assets/knight.png'));
    expect(detectFormat(new Uint8Array(bytes))).toBe('png');
  }, 180000);

  it('animates the sprite with a $file reference and saves every frame', async () => {
    const out = await performApiRequest({
      url: '/animate-with-text',
      body: {
        image_size: { width: 64, height: 64 },
        description: 'small knight character with sword and shield',
        action: 'walk',
        view: 'side',
        direction: 'east',
        n_frames: 4,
        reference_image: { type: 'base64', base64: { $file: 'assets/knight.png' } },
      },
      save_images_dir: 'assets/knight_walk',
      save_images_prefix: 'walk',
      timeout_ms: 180000,
    }, auth, d.baseUrl, deps);
    console.log(out);
    expect(out).toContain('HTTP 200');
    const frames = fs.readdirSync(path.join(OUT, 'assets/knight_walk')).filter(f => f.endsWith('.png'));
    expect(frames.length).toBeGreaterThanOrEqual(4);
    expect(out).not.toContain(KEY);
    console.log('frames:', frames.map(f => path.join(OUT, 'assets/knight_walk', f)).join('\n'));
  }, 240000);

  it('creates a character (async job) and waits for it with poll in ONE call', async () => {
    const created = await performApiRequest({
      url: '/create-character-v3',
      body: { description: 'small knight character with sword and shield', image_size: { width: 64, height: 64 }, no_background: true },
      timeout_ms: 120000,
    }, auth, d.baseUrl, deps);
    console.log(created);
    expect(created).toContain('HTTP 200');
    const jobId = created.match(/"background_job_id": "([^"]+)"/)?.[1];
    expect(jobId).toBeTruthy();

    const done = await performApiRequest({
      url: `/background-jobs/${jobId}`,
      poll: { status_field: 'status', done_values: ['completed', 'failed'], interval_ms: 5000, max_wait_ms: 300000 },
    }, auth, d.baseUrl, deps);
    console.log(done.slice(0, 1500));
    expect(done).toContain('"status": "completed"');
  }, 360000);
});

describe.skipIf(!!KEY)('PixelLab end-to-end', () => {
  it.skip('skipped — set PIXELLAB_API_KEY to run the live test', () => { /* placeholder */ });
});
