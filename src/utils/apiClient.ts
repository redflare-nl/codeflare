/**
 * Authenticated HTTP + OpenAPI discovery for external web APIs, vscode-free.
 *
 * The extension layer (llm/tools.ts) supplies the credential, the workspace
 * file I/O and the policy gate through `ApiDeps`; this module owns the HTTP
 * mechanics: credential injection, request bodies that reference workspace
 * files, binary / base64-image responses written to files instead of into the
 * model's context, polling of asynchronous jobs, and secret redaction of
 * everything that is returned to the model.
 */

import {
  OpenApiDoc, authInfo, compactJson, detectFormat, extractEmbeddedImages, getPath,
  parseSpec, redactSecrets, specBaseUrl, specLinksInText, specUrlCandidates, stemFromJsonPath,
} from './apiSpec';

export interface ApiAuth {
  scheme: 'bearer' | 'header' | 'query' | 'basic';
  /** Header / query-parameter name (defaults: Authorization / api_key). */
  name?: string;
  /** Value prefix for header schemes (default "Bearer " for bearer). */
  prefix?: string;
  value: string;
}

export interface PollSpec {
  /** JSON path of the status field (default "status"). */
  status_field?: string;
  /** Values that end the wait (default: completed/complete/done/succeeded/success/finished/failed/error/cancelled). */
  done_values?: string[];
  interval_ms?: number;
  max_wait_ms?: number;
}

export interface ApiRequestInput {
  method?: string;
  url: string;
  query?: Record<string, any>;
  headers?: Record<string, string>;
  body?: any;
  timeout_ms?: number;
  /** Workspace path for a binary response (image/zip/…), or for the single image in a JSON response. */
  save_to?: string;
  /** Workspace folder where every base64 image found in a JSON response is written. */
  save_images_dir?: string;
  /** File-name stem for saved images (default: derived from the JSON path). */
  save_images_prefix?: string;
  poll?: PollSpec;
  /** Cap on the JSON text returned to the model (default 8000). */
  max_chars?: number;
}

export interface SaveResult { ok: true; rel: string; bytes: number }
export interface SaveError { ok: false; error: string }

export interface ApiDeps {
  fetchImpl?: typeof fetch;
  /** Write bytes to a workspace-relative path (policy-gated + checkpointed by the caller). */
  saveFile: (relPath: string, bytes: Uint8Array) => Promise<SaveResult | SaveError>;
  /** Read a workspace file for `{"$file": …}` body references. */
  readFile?: (relPath: string) => Promise<Uint8Array | { error: string }>;
  sleep?: (ms: number) => Promise<void>;
  /** Extra strings that must never reach the model (other stored credentials). */
  redact?: string[];
  /** Progress callback (poll attempts) for the UI. */
  onProgress?: (msg: string) => void;
  now?: () => number;
}

const DEFAULT_DONE = ['completed', 'complete', 'done', 'succeeded', 'success', 'finished', 'failed', 'error', 'errored', 'cancelled', 'canceled'];
const BINARY_CT = /^(image|audio|video)\/|^application\/(zip|octet-stream|pdf|gzip|x-tar|x-zip-compressed|vnd\.)/i;

function extFor(contentType: string, bytes: Uint8Array): string {
  const magic = detectFormat(bytes);
  if (magic) { return magic; }
  const m = contentType.match(/^[a-z]+\/([a-z0-9.+-]+)/i);
  if (!m) { return 'bin'; }
  const sub = m[1].toLowerCase();
  if (sub === 'jpeg') { return 'jpg'; }
  if (sub === 'svg+xml') { return 'svg'; }
  if (sub === 'octet-stream') { return 'bin'; }
  return sub.replace(/^x-/, '').replace(/[^a-z0-9]/g, '') || 'bin';
}

function withExt(rel: string, ext: string): string {
  return /\.[a-z0-9]{2,5}$/i.test(rel) ? rel : `${rel}.${ext}`;
}

function joinDir(dir: string, name: string): string {
  const d = (dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return d ? `${d}/${name}` : name;
}

/** Build the absolute request URL: absolute as-is, otherwise relative to `baseUrl`. */
export function resolveUrl(url: string, baseUrl?: string): string | { error: string } {
  const u = String(url || '').trim();
  if (/^https?:\/\//i.test(u)) { return u; }
  if (!baseUrl) {
    return { error: `"${u}" is not an absolute URL and the service has no known base URL yet — ` +
      `run api_discover first (it records the base URL) or pass an absolute https:// URL.` };
  }
  const b = baseUrl.replace(/\/+$/, '');
  try {
    const bu = new URL(b + '/');
    // A leading "/" is relative to the base PATH (e.g. /v2), not to the origin:
    // OpenAPI paths are always relative to servers[0].url.
    return new URL(u.replace(/^\/+/, ''), bu).toString();
  } catch (err: any) {
    return { error: `Cannot build a URL from base "${baseUrl}" and "${u}": ${err.message}` };
  }
}

/** Replace `{"$file": "path"}` / `{"$dataUrl": "path"}` markers with file content. */
export async function inlineFileRefs(body: any, deps: ApiDeps): Promise<{ body: any } | { error: string }> {
  if (!deps.readFile) { return { body }; }
  let error: string | undefined;
  const visit = async (node: any, depth: number): Promise<any> => {
    if (error || depth > 20 || node === null || typeof node !== 'object') { return node; }
    if (Array.isArray(node)) {
      const out: any[] = [];
      for (const v of node) { out.push(await visit(v, depth + 1)); }
      return out;
    }
    const keys = Object.keys(node);
    if (keys.length === 1 && (keys[0] === '$file' || keys[0] === '$dataUrl') && typeof node[keys[0]] === 'string') {
      const rel = node[keys[0]];
      const data = await deps.readFile!(rel);
      if ('error' in data) { error = `Cannot read "${rel}" for ${keys[0]}: ${data.error}`; return node; }
      const b64 = Buffer.from(data).toString('base64');
      if (keys[0] === '$file') { return b64; }
      const fmt = detectFormat(data);
      const mime = fmt === 'jpg' ? 'image/jpeg' : fmt ? `image/${fmt}` : 'application/octet-stream';
      return `data:${mime};base64,${b64}`;
    }
    const out: Record<string, any> = {};
    for (const k of keys) { out[k] = await visit(node[k], depth + 1); }
    return out;
  };
  const result = await visit(body, 0);
  return error ? { error } : { body: result };
}

function applyAuth(url: URL, headers: Record<string, string>, auth?: ApiAuth): void {
  if (!auth || !auth.value) { return; }
  switch (auth.scheme) {
    case 'bearer':
      headers[auth.name || 'Authorization'] = `${auth.prefix ?? 'Bearer '}${auth.value}`;
      break;
    case 'header':
      headers[auth.name || 'X-API-Key'] = `${auth.prefix ?? ''}${auth.value}`;
      break;
    case 'basic':
      headers['Authorization'] = 'Basic ' + Buffer.from(auth.value).toString('base64');
      break;
    case 'query':
      url.searchParams.set(auth.name || 'api_key', auth.value);
      break;
  }
}

interface FetchOnce {
  status: number;
  statusText: string;
  contentType: string;
  bytes: Uint8Array;
  text: () => string;
  json: () => any | undefined;
}

async function fetchOnce(
  fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number
): Promise<FetchOnce | { error: string }> {
  let resp: Response;
  try {
    resp = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err: any) {
    const msg = err?.name === 'TimeoutError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (err?.message || String(err));
    return { error: `Request failed: ${msg}` };
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  let cachedText: string | undefined;
  const text = () => (cachedText ??= new TextDecoder().decode(bytes));
  return {
    status: resp.status,
    statusText: resp.statusText,
    contentType: resp.headers.get('content-type') || '',
    bytes,
    text,
    json: () => { try { return JSON.parse(text()); } catch { return undefined; } },
  };
}

/**
 * Perform one API request (optionally polling until a job finishes) and
 * return a model-readable report. Never throws; never leaks the credential.
 */
export async function performApiRequest(
  input: ApiRequestInput,
  auth: ApiAuth | undefined,
  baseUrl: string | undefined,
  deps: ApiDeps
): Promise<string> {
  const secrets = [auth?.value || '', ...(deps.redact || [])].filter(Boolean);
  const safe = (s: string) => redactSecrets(s, secrets);
  const fetchImpl = deps.fetchImpl || fetch;
  const sleep = deps.sleep || (ms => new Promise<void>(r => setTimeout(r, ms)));
  const now = deps.now || Date.now;

  const method = (input.method || (input.body !== undefined ? 'POST' : 'GET')).toUpperCase();
  const resolved = resolveUrl(input.url, baseUrl);
  if (typeof resolved !== 'string') { return resolved.error; }
  let url: URL;
  try { url = new URL(resolved); } catch { return `Invalid URL: ${safe(resolved)}`; }
  if (url.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) {
    return `Refusing to send a request over plain http to ${url.hostname} — use https (plain http is only allowed for localhost).`;
  }
  for (const [k, v] of Object.entries(input.query || {})) {
    if (v === undefined || v === null) { continue; }
    url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }

  const headers: Record<string, string> = { 'Accept': 'application/json, */*;q=0.8', 'User-Agent': 'CodeFlare/1.0 (+vscode)' };
  for (const [k, v] of Object.entries(input.headers || {})) {
    if (/^authorization$/i.test(k) && auth) { continue; } // the stored credential wins
    headers[k] = String(v);
  }
  applyAuth(url, headers, auth);

  let bodyInit: string | undefined;
  if (input.body !== undefined && input.body !== null && method !== 'GET' && method !== 'HEAD') {
    const inl = await inlineFileRefs(input.body, deps);
    if ('error' in inl) { return inl.error; }
    if (typeof inl.body === 'string') {
      bodyInit = inl.body;
      if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) { headers['Content-Type'] = 'text/plain'; }
    } else {
      bodyInit = JSON.stringify(inl.body);
      if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) { headers['Content-Type'] = 'application/json'; }
    }
  }

  const timeoutMs = Math.min(Math.max(input.timeout_ms || 60000, 1000), 300000);
  const init: RequestInit = { method, headers, body: bodyInit };

  let res = await fetchOnce(fetchImpl, url.toString(), init, timeoutMs);
  if ('error' in res) { return safe(`${method} ${url.toString()} — ${res.error}`); }

  // ── Polling: repeat a GET until the status field reaches a terminal value ──
  let polls = 0;
  if (input.poll && method === 'GET') {
    const field = input.poll.status_field || 'status';
    const done = (input.poll.done_values && input.poll.done_values.length ? input.poll.done_values : DEFAULT_DONE)
      .map(v => String(v).toLowerCase());
    const interval = Math.min(Math.max(input.poll.interval_ms || 3000, 500), 60000);
    const maxWait = Math.min(Math.max(input.poll.max_wait_ms || 120000, interval), 600000);
    const start = now();
    while (true) {
      const j = res.json();
      const status = j !== undefined ? getPath(j, field) : undefined;
      const st = status === undefined ? undefined : String(status).toLowerCase();
      if (st !== undefined && done.includes(st)) { break; }
      if (res.status >= 400 && res.status !== 404 && res.status !== 202) { break; }
      if (now() - start + interval > maxWait) {
        const jl = j !== undefined ? compactJson(j, 1500) : res.text().slice(0, 1500);
        return safe(`Still not finished after ${polls + 1} poll(s) over ${Math.round((now() - start) / 1000)}s — ` +
          `last "${field}" = ${JSON.stringify(status)}. Last response:\n${jl}\n` +
          `Poll again (same api_request) with a larger poll.max_wait_ms, or report the job id to the user.`);
      }
      polls++;
      deps.onProgress?.(`polling ${url.pathname} — ${field}=${status ?? '?'} (attempt ${polls})`);
      await sleep(interval);
      res = await fetchOnce(fetchImpl, url.toString(), init, timeoutMs);
      if ('error' in res) { return safe(`${method} ${url.toString()} — ${res.error} (after ${polls} poll(s))`); }
    }
  }

  const head = `HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''} — ${method} ${url.pathname}${polls ? ` (after ${polls} poll(s))` : ''}`;
  const maxChars = Math.min(Math.max(input.max_chars || 8000, 500), 60000);

  if (res.status >= 400) {
    const j = res.json();
    const bodyText = j !== undefined ? compactJson(j, 4000) : res.text().slice(0, 4000);
    const hint = res.status === 401 || res.status === 403
      ? '\nThe credential was rejected or lacks permission — check the stored key (api_services) and the auth scheme the spec declares.'
      : res.status === 422 || res.status === 400
        ? '\nThe request shape was rejected — call api_describe for this operation and match its parameter names, types and enums exactly.'
        : res.status === 402 ? '\nPayment/credits required — the account balance may be exhausted.' : '';
    return safe(`${head}\n${bodyText}${hint}`);
  }

  // ── Binary body → must go to a file ──
  const isJsonCt = /json/i.test(res.contentType);
  const magic = detectFormat(res.bytes);
  if (!isJsonCt && (BINARY_CT.test(res.contentType) || magic)) {
    if (!input.save_to) {
      return safe(`${head}\nBinary response (${res.contentType || magic}, ${res.bytes.length} bytes). ` +
        `Repeat the request with save_to:"<workspace path>" to write it to a file.`);
    }
    const rel = withExt(input.save_to.replace(/\\/g, '/'), extFor(res.contentType, res.bytes));
    const saved = await deps.saveFile(rel, res.bytes);
    if (!saved.ok) { return safe(`${head}\n${saved.error}`); }
    return safe(`${head}\nSaved file to "${saved.rel}" (${saved.bytes} bytes, ${res.contentType || magic}).`);
  }

  // ── JSON (or text) body ──
  const json = res.json();
  if (json === undefined) {
    const t = res.text();
    return safe(`${head}\n${t.length > maxChars ? t.slice(0, maxChars) + '\n… (truncated)' : t || '(empty body)'}`);
  }

  const lines: string[] = [head];
  const wantsImages = !!(input.save_images_dir || input.save_to);
  const embedded = extractEmbeddedImages(json);
  if (embedded.length && wantsImages) {
    let i = 0;
    for (const im of embedded) {
      let rel: string;
      if (input.save_to && embedded.length === 1) {
        rel = withExt(input.save_to.replace(/\\/g, '/'), im.format);
      } else {
        const stem = input.save_images_prefix
          ? `${input.save_images_prefix}_${i}`
          : stemFromJsonPath(im.jsonPath, i);
        rel = joinDir(input.save_images_dir || input.save_to!.replace(/\.[a-z0-9]+$/i, ''), `${stem}.${im.format}`);
      }
      const saved = await deps.saveFile(rel, im.bytes);
      if (saved.ok) {
        lines.push(`Saved image to "${saved.rel}" (${saved.bytes} bytes, ${im.format}, from ${im.jsonPath})`);
        im.replace(`<saved to ${saved.rel}>`);
      } else {
        lines.push(`Could not save ${im.jsonPath}: ${saved.error}`);
        im.replace(`<${im.format} image, ${im.bytes.length} bytes, NOT saved>`);
      }
      i++;
    }
  } else if (embedded.length) {
    for (const im of embedded) { im.replace(`<${im.format} image, ${im.bytes.length} bytes — pass save_images_dir to write it to a file>`); }
    lines.push(`The response contains ${embedded.length} embedded image(s); repeat with save_images_dir:"<folder>" to save them.`);
  }
  lines.push(compactJson(json, maxChars));
  return safe(lines.join('\n'));
}

// ── Discovery ────────────────────────────────────────────────────

export interface DiscoveredSpec {
  specUrl: string;
  baseUrl: string;
  spec: OpenApiDoc;
  title: string;
  version: string;
  endpointCount: number;
  auth: ReturnType<typeof authInfo>;
  /** Other valid specs found (older API versions etc.). */
  alternatives: { specUrl: string; endpointCount: number; title: string }[];
  tried: number;
}

export interface DiscoveryFailure {
  tried: string[];
  hints: string[];
}

async function fetchText(fetchImpl: typeof fetch, url: string, timeoutMs: number, maxBytes: number): Promise<{ status: number; contentType: string; text: string } | null> {
  try {
    const resp = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Accept': 'application/json, text/plain, text/html;q=0.5', 'User-Agent': 'CodeFlare/1.0 (+vscode)' },
    });
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length > maxBytes) { return { status: resp.status, contentType: resp.headers.get('content-type') || '', text: '' }; }
    return { status: resp.status, contentType: resp.headers.get('content-type') || '', text: new TextDecoder().decode(buf) };
  } catch {
    return null;
  }
}

/**
 * Locate and parse an OpenAPI document for a site / API base URL. Tries the
 * conventional spec locations (plus links found in llms.txt and the given
 * page), collects every valid spec and returns the richest one (most
 * operations — usually the newest API version), listing the others.
 */
export async function discoverSpec(
  input: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; concurrency?: number; onProgress?: (m: string) => void } = {}
): Promise<DiscoveredSpec | DiscoveryFailure> {
  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs || 10000;
  const concurrency = opts.concurrency || 6;
  const MAX_SPEC = 8 * 1024 * 1024;

  let seed = input.trim();
  if (!/^https?:\/\//i.test(seed)) { seed = 'https://' + seed; }
  const tried: string[] = [];
  const found: { specUrl: string; spec: OpenApiDoc }[] = [];
  const seen = new Set<string>();

  // If the input itself is a spec, we're done quickly.
  const direct = await fetchText(fetchImpl, seed, timeoutMs, MAX_SPEC);
  tried.push(seed);
  let seedText = '';
  if (direct && direct.status < 400) {
    const spec = parseSpec(direct.text);
    if (spec) { found.push({ specUrl: seed, spec }); }
    else { seedText = direct.text; }
  }
  seen.add(seed);

  const candidates: string[] = [];
  const add = (u: string) => { if (!seen.has(u)) { seen.add(u); candidates.push(u); } };

  // Links in the page the user pointed at (docs page, homepage).
  if (seedText) { for (const l of specLinksInText(seedText, seed)) { add(l); } }
  // llms.txt at the origin and at the given base commonly links the spec.
  let origin = '';
  try { origin = new URL(seed).origin; } catch { /* ignore */ }
  const llmsUrls = new Set<string>();
  if (origin) { llmsUrls.add(`${origin}/llms.txt`); }
  const basePath = seed.replace(/\/+$/, '');
  if (basePath !== origin) { llmsUrls.add(`${basePath}/llms.txt`); }
  for (const lu of llmsUrls) {
    const r = await fetchText(fetchImpl, lu, timeoutMs, 512 * 1024);
    tried.push(lu);
    if (r && r.status < 400 && r.text && !/^\s*</.test(r.text)) {
      for (const l of specLinksInText(r.text, lu)) { add(l); }
    }
  }
  for (const c of specUrlCandidates(seed)) { add(c); }

  // Fetch in bounded parallel batches; stop early once the first batch after a
  // hit has completed (cheap hosts answer 404 fast; we still want v1 vs v2).
  for (let i = 0; i < candidates.length && found.length < 6; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    opts.onProgress?.(`probing ${batch[0]} … (+${batch.length - 1})`);
    const results = await Promise.all(batch.map(async u => {
      tried.push(u);
      const r = await fetchText(fetchImpl, u, timeoutMs, MAX_SPEC);
      if (!r || r.status >= 400 || !r.text) { return null; }
      const spec = parseSpec(r.text);
      return spec ? { specUrl: u, spec } : null;
    }));
    for (const r of results) { if (r) { found.push(r); } }
    // Once something is found, finish the version sweep of the same host only.
    if (found.length && i + concurrency >= 24) { break; }
  }

  if (found.length === 0) {
    return {
      tried,
      hints: [
        'No OpenAPI/Swagger JSON was found at the conventional locations.',
        'Next: web_search "<service> API documentation openapi" or "<service> API reference", open the docs with web_fetch, and pass the exact spec URL (…/openapi.json or …/swagger.json) or the API base URL to api_discover.',
        'If the service has no machine-readable spec, read its docs pages with web_fetch and call api_request directly with the documented paths.',
      ],
    };
  }

  const ranked = found
    .map(f => ({ ...f, count: Object.values(f.spec.paths || {}).reduce((n, item) => n + Object.keys(item || {}).filter(k => HTTP_SET.has(k)).length, 0) }))
    .sort((a, b) => b.count - a.count);
  const best = ranked[0];
  return {
    specUrl: best.specUrl,
    baseUrl: specBaseUrl(best.spec, best.specUrl),
    spec: best.spec,
    title: best.spec.info?.title || '(untitled API)',
    version: best.spec.info?.version || '',
    endpointCount: best.count,
    auth: authInfo(best.spec),
    alternatives: ranked.slice(1).map(r => ({ specUrl: r.specUrl, endpointCount: r.count, title: r.spec.info?.title || '' })),
    tried: tried.length,
  };
}

const HTTP_SET = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** Human summary of a discovery result for the model. */
export function renderDiscovery(d: DiscoveredSpec, endpointList: string): string {
  const alt = d.alternatives.length
    ? `\nOther specs found (not selected): ${d.alternatives.map(a => `${a.specUrl} (${a.endpointCount} endpoints)`).join('; ')}`
    : '';
  return `${d.title}${d.version ? ' v' + d.version : ''}\n` +
    `Spec: ${d.specUrl}\nBase URL: ${d.baseUrl} (api_request paths are relative to this)\n` +
    `Auth: ${d.auth.description}${alt}\n\n${endpointList}\n\n` +
    `Next: api_describe(service, method, path) for the exact parameters of the operation you need — do not guess field names.`;
}
