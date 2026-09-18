/**
 * OpenAPI helpers for the external-API tools (api_discover / api_describe /
 * api_request). Pure and vscode-free so it can be unit-tested and reused by
 * the E2E test against a real service.
 *
 * The problem these solve: a real OpenAPI document is far too big for the
 * model's context (PixelLab's v2 spec is ~415 KB), so the agent needs a
 * compact endpoint index first and the exact parameter schema of ONE
 * operation second — never the whole document.
 */

export interface OpenApiDoc {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: { url: string; description?: string }[];
  basePath?: string;
  host?: string;
  schemes?: string[];
  paths?: Record<string, Record<string, any>>;
  components?: { securitySchemes?: Record<string, any>; schemas?: Record<string, any> };
  securityDefinitions?: Record<string, any>;
  security?: any[];
  tags?: { name: string; description?: string }[];
}

export interface EndpointSummary {
  method: string;
  path: string;
  summary: string;
  tag: string;
  deprecated: boolean;
}

export interface AuthInfo {
  /** How the credential travels. `none` = the spec declares no security scheme. */
  scheme: 'bearer' | 'header' | 'query' | 'basic' | 'none';
  /** Header or query-parameter name for `header`/`query` schemes. */
  name?: string;
  description: string;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** Parse a JSON OpenAPI/Swagger document. Returns null for anything else. */
export function parseSpec(text: string): OpenApiDoc | null {
  let doc: any;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!doc || typeof doc !== 'object' || !doc.paths || typeof doc.paths !== 'object') { return null; }
  if (!doc.openapi && !doc.swagger) { return null; }
  return doc as OpenApiDoc;
}

/**
 * The absolute base URL API paths hang off: servers[0].url (OpenAPI 3; may be
 * relative to the spec's origin) or host+basePath (Swagger 2), falling back
 * to the spec URL's directory.
 */
export function specBaseUrl(spec: OpenApiDoc, specUrl: string): string {
  let origin = '';
  let specDir = '';
  try {
    const u = new URL(specUrl);
    origin = u.origin;
    specDir = specUrl.replace(/\/[^/]*$/, '');
  } catch { /* relative spec url — leave blank */ }

  const server = spec.servers?.[0]?.url?.trim();
  if (server) {
    if (/^https?:\/\//i.test(server)) { return server.replace(/\/+$/, ''); }
    if (server.startsWith('/')) { return (origin + server).replace(/\/+$/, ''); }
    return (specDir + '/' + server).replace(/\/+$/, '');
  }
  if (spec.host) {
    const scheme = spec.schemes?.includes('https') || !spec.schemes ? 'https' : spec.schemes[0];
    return `${scheme}://${spec.host}${spec.basePath || ''}`.replace(/\/+$/, '');
  }
  return specDir || origin;
}

/** Which credential the spec expects, so api_request can inject it correctly. */
export function authInfo(spec: OpenApiDoc): AuthInfo {
  const schemes = spec.components?.securitySchemes || spec.securityDefinitions || {};
  const entries = Object.entries(schemes);
  if (entries.length === 0) { return { scheme: 'none', description: 'No security scheme declared.' }; }
  // Prefer a scheme referenced by the top-level security requirement.
  const preferred = spec.security?.flatMap(s => Object.keys(s || {}))?.[0];
  const [key, def] = (preferred && schemes[preferred]) ? [preferred, schemes[preferred]] : entries[0];
  const type = String(def?.type || '').toLowerCase();
  const sch = String(def?.scheme || '').toLowerCase();
  if (type === 'http' && sch === 'bearer') {
    return { scheme: 'bearer', name: 'Authorization', description: `${key}: Authorization: Bearer <token>` };
  }
  if (type === 'http' && sch === 'basic') {
    return { scheme: 'basic', name: 'Authorization', description: `${key}: HTTP basic auth` };
  }
  if (type === 'apikey') {
    const where = String(def?.in || 'header').toLowerCase();
    const name = String(def?.name || 'X-API-Key');
    if (where === 'query') { return { scheme: 'query', name, description: `${key}: query parameter ${name}` }; }
    return { scheme: 'header', name, description: `${key}: header ${name}` };
  }
  if (type === 'oauth2' || type === 'openidconnect') {
    return { scheme: 'bearer', name: 'Authorization', description: `${key}: OAuth2 access token as Authorization: Bearer <token>` };
  }
  return { scheme: 'bearer', name: 'Authorization', description: `${key}: ${type || 'unknown'} (assuming bearer)` };
}

/** Every operation in the document, in path order. */
export function listEndpoints(spec: OpenApiDoc): EndpointSummary[] {
  const out: EndpointSummary[] = [];
  for (const [p, item] of Object.entries(spec.paths || {})) {
    if (!item || typeof item !== 'object') { continue; }
    for (const m of HTTP_METHODS) {
      const op = item[m];
      if (!op || typeof op !== 'object') { continue; }
      out.push({
        method: m.toUpperCase(),
        path: p,
        summary: oneLine(op.summary || op.operationId || op.description || ''),
        tag: Array.isArray(op.tags) && op.tags.length ? String(op.tags[0]) : '',
        deprecated: op.deprecated === true,
      });
    }
  }
  return out;
}

function oneLine(s: string, max = 90): string {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * A compact, grouped endpoint index. `filter` narrows by keyword (matched
 * against method, path, summary, tag and the operation description); `max`
 * caps the number of lines, telling the model how many were left out.
 */
export function renderEndpointList(spec: OpenApiDoc, opts: { filter?: string; max?: number } = {}): string {
  const max = Math.max(10, opts.max ?? 120);
  const words = (opts.filter || '').toLowerCase().split(/\s+/).map(w => w.trim()).filter(Boolean);
  let eps = listEndpoints(spec);
  if (words.length) {
    eps = eps.filter(e => {
      const op = spec.paths?.[e.path]?.[e.method.toLowerCase()] || {};
      const hay = `${e.method} ${e.path} ${e.summary} ${e.tag} ${op.description || ''}`.toLowerCase();
      return words.every(w => hay.includes(w));
    });
  }
  if (eps.length === 0) {
    return words.length
      ? `No endpoints match "${opts.filter}". Call again without a filter (or with a broader one) to see all ${listEndpoints(spec).length}.`
      : 'The spec declares no operations.';
  }
  const groups = new Map<string, EndpointSummary[]>();
  for (const e of eps) {
    const g = e.tag || '(untagged)';
    if (!groups.has(g)) { groups.set(g, []); }
    groups.get(g)!.push(e);
  }
  const lines: string[] = [];
  let shown = 0;
  let truncated = false;
  for (const [tag, list] of groups) {
    if (shown >= max) { truncated = true; break; }
    lines.push(`## ${tag}`);
    for (const e of list) {
      if (shown >= max) { truncated = true; break; }
      lines.push(`${e.method.padEnd(6)} ${e.path}${e.summary ? ' — ' + e.summary : ''}${e.deprecated ? ' [deprecated]' : ''}`);
      shown++;
    }
  }
  const head = `${eps.length} endpoint(s)${words.length ? ` matching "${opts.filter}"` : ''}:`;
  const tail = truncated
    ? `\n… ${eps.length - shown} more not shown — call api_discover again with a filter keyword to narrow.`
    : '';
  return `${head}\n${lines.join('\n')}${tail}`;
}

/** Resolve `$ref` pointers (local only), bounded so recursive schemas terminate. */
export function deref(spec: OpenApiDoc, node: any, depth = 0): any {
  if (depth > 12 || node === null || typeof node !== 'object') { return node; }
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    const parts = node.$ref.slice(2).split('/').map((s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    let t: any = spec;
    for (const k of parts) { t = t?.[k]; if (t === undefined) { return { type: 'unknown', description: `unresolved ${node.$ref}` }; } }
    return deref(spec, t, depth + 1);
  }
  return node;
}

function refName(node: any): string | undefined {
  const r = node && typeof node.$ref === 'string' ? node.$ref : undefined;
  return r ? r.split('/').pop() : undefined;
}

function typeOf(spec: OpenApiDoc, schema: any): string {
  const s = deref(spec, schema);
  if (!s || typeof s !== 'object') { return 'any'; }
  const alt = s.anyOf || s.oneOf || s.allOf;
  if (Array.isArray(alt)) {
    return alt.map((a: any) => refName(a) || typeOf(spec, a)).filter((v: string, i: number, arr: string[]) => arr.indexOf(v) === i).join(' | ');
  }
  if (s.type === 'array') { return `array of ${refName(s.items) || typeOf(spec, s.items)}`; }
  if (s.enum) { return 'enum'; }
  if (s.type === 'object' || s.properties) { return refName(schema) || 'object'; }
  if (s.type === 'null') { return 'null'; }
  return s.type ? String(s.type) + (s.format ? `(${s.format})` : '') : 'any';
}

function enumOf(spec: OpenApiDoc, schema: any): any[] | undefined {
  const s = deref(spec, schema);
  if (!s || typeof s !== 'object') { return undefined; }
  if (Array.isArray(s.enum)) { return s.enum; }
  const alt = s.anyOf || s.oneOf;
  if (Array.isArray(alt)) {
    for (const a of alt) { const e = enumOf(spec, a); if (e) { return e; } }
  }
  if (s.type === 'array') { return enumOf(spec, s.items); }
  return undefined;
}

/** Merge allOf/anyOf object members so their properties are listed together. */
function objectSchema(spec: OpenApiDoc, schema: any): { properties: Record<string, any>; required: string[] } | null {
  const s = deref(spec, schema);
  if (!s || typeof s !== 'object') { return null; }
  const props: Record<string, any> = {};
  const req = new Set<string>((s.required as string[]) || []);
  let found = false;
  if (s.properties) { Object.assign(props, s.properties); found = true; }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(s[key])) {
      for (const member of s[key]) {
        const o = objectSchema(spec, member);
        if (o) { Object.assign(props, o.properties); o.required.forEach(r => req.add(r)); found = true; }
      }
    }
  }
  if (!found && s.type === 'array') { return objectSchema(spec, s.items); }
  return found ? { properties: props, required: [...req] } : null;
}

function renderProps(spec: OpenApiDoc, schema: any, indent: string, depth: number, out: string[], seen: Set<string>): void {
  const obj = objectSchema(spec, schema);
  if (!obj) { return; }
  const entries = Object.entries(obj.properties);
  const cap = depth === 0 ? 60 : 25;
  for (const [name, raw] of entries.slice(0, cap)) {
    const s = deref(spec, raw);
    const parts = [`${indent}- ${name}: ${typeOf(spec, raw)}`];
    if (obj.required.includes(name)) { parts.push('REQUIRED'); }
    const en = enumOf(spec, raw);
    if (en) { parts.push(`one of ${en.slice(0, 40).map(v => JSON.stringify(v)).join(' | ')}${en.length > 40 ? ' …' : ''}`); }
    if (s?.default !== undefined) { parts.push(`default ${JSON.stringify(s.default)}`); }
    if (s?.minimum !== undefined || s?.maximum !== undefined) { parts.push(`range ${s.minimum ?? '…'}..${s.maximum ?? '…'}`); }
    if (s?.description) { parts.push(oneLine(String(s.description), 160)); }
    out.push(parts.join(' — '));
    // Nested object: one level of detail, guarded against recursion.
    const name2 = refName(raw) || (s?.type === 'array' ? refName(s.items) : undefined);
    const nested = s?.type === 'array' ? s.items : raw;
    if (depth < 2 && objectSchema(spec, nested) && !(name2 && seen.has(name2))) {
      if (name2) { seen.add(name2); }
      renderProps(spec, nested, indent + '    ', depth + 1, out, seen);
    }
  }
  if (entries.length > cap) { out.push(`${indent}… ${entries.length - cap} more properties`); }
}

/**
 * The full contract of ONE operation: description, path/query parameters,
 * request body properties (type, required, enum, default, description) and
 * the 200-response shape. Null when the operation does not exist.
 */
export function describeOperation(spec: OpenApiDoc, method: string, path: string): string | null {
  const m = method.toLowerCase();
  const item = spec.paths?.[path];
  const op = item?.[m];
  if (!op) { return null; }
  const out: string[] = [`${m.toUpperCase()} ${path}${op.summary ? ' — ' + oneLine(op.summary, 120) : ''}`];
  if (op.deprecated) { out.push('DEPRECATED'); }
  if (op.description) {
    const d = String(op.description).replace(/\r/g, '').trim();
    out.push(d.length > 1200 ? d.slice(0, 1200) + '…' : d);
  }
  const params = [...(item?.parameters || []), ...(op.parameters || [])].map(p => deref(spec, p));
  if (params.length) {
    out.push('', 'Parameters:');
    for (const p of params) {
      const parts = [`- ${p.name} (${p.in}): ${typeOf(spec, p.schema || p)}`];
      if (p.required) { parts.push('REQUIRED'); }
      const en = enumOf(spec, p.schema || p);
      if (en) { parts.push(`one of ${en.map(v => JSON.stringify(v)).join(' | ')}`); }
      if (p.description) { parts.push(oneLine(String(p.description), 160)); }
      out.push(parts.join(' — '));
    }
  }
  const body = deref(spec, op.requestBody);
  const content = body?.content || {};
  const ctype = Object.keys(content)[0];
  if (ctype) {
    out.push('', `Request body (${ctype})${body.required ? ' REQUIRED' : ''}:`);
    const schema = content[ctype].schema;
    const lines: string[] = [];
    renderProps(spec, schema, '', 0, lines, new Set([refName(schema) || '']));
    if (lines.length) { out.push(...lines); } else { out.push(`- ${typeOf(spec, schema)}`); }
  } else if (Array.isArray(op.parameters)) {
    // Swagger 2 body parameter.
    const bp = params.find(p => p.in === 'body');
    if (bp) {
      out.push('', 'Request body:');
      const lines: string[] = [];
      renderProps(spec, bp.schema, '', 0, lines, new Set());
      out.push(...lines);
    }
  }
  const resp = op.responses?.['200'] || op.responses?.['201'] || op.responses?.['202'] || op.responses?.default;
  const rd = deref(spec, resp);
  const rct = rd?.content ? Object.keys(rd.content)[0] : undefined;
  if (rct) {
    out.push('', `Response (${rct}):`);
    const lines: string[] = [];
    const rs = rd.content[rct].schema;
    renderProps(spec, rs, '', 0, lines, new Set([refName(rs) || '']));
    if (lines.length) { out.push(...lines.slice(0, 40)); } else { out.push(`- ${typeOf(spec, rs)}`); }
  } else if (rd?.schema) {
    out.push('', 'Response:');
    const lines: string[] = [];
    renderProps(spec, rd.schema, '', 0, lines, new Set());
    out.push(...lines.slice(0, 40));
  }
  const text = out.join('\n');
  return text.length > 9000 ? text.slice(0, 9000) + '\n… (truncated)' : text;
}

/** Find an operation by method+path, tolerating a missing/extra leading slash or a base prefix. */
export function findOperationPath(spec: OpenApiDoc, path: string): string | undefined {
  const paths = Object.keys(spec.paths || {});
  const want = '/' + path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (spec.paths?.[want]) { return want; }
  // The model may pass the full URL path including the server prefix (/v2/...).
  const hit = paths.find(p => want.endsWith(p) || want === p);
  return hit;
}

// ── Secrets & binary helpers ─────────────────────────────────────

/** Mask every occurrence of the given secrets in a text (case-sensitive, ≥8 chars only). */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 8) { continue; }
    out = out.split(s).join('***REDACTED***');
    // Also catch URL-encoded and base64-embedded forms of the raw token.
    const enc = encodeURIComponent(s);
    if (enc !== s) { out = out.split(enc).join('***REDACTED***'); }
  }
  return out;
}

export type ImageFormat = 'png' | 'gif' | 'jpg' | 'webp' | 'bmp' | 'zip' | 'pdf';

/** Detect a file format from magic bytes (images + the archive formats generators return). */
export function detectFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length < 12) { return null; }
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) { return 'png'; }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) { return 'gif'; }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) { return 'jpg'; }
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) { return 'webp'; }
  if (b[0] === 0x42 && b[1] === 0x4d) { return 'bmp'; }
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05)) { return 'zip'; }
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) { return 'pdf'; }
  return null;
}

export interface EmbeddedImage {
  /** Dot/bracket path inside the JSON, e.g. `images[0].base64`. */
  jsonPath: string;
  bytes: Uint8Array;
  format: ImageFormat;
  /** Setter that replaces the value in the parsed JSON (with a note) once saved. */
  replace: (note: string) => void;
}

const BASE64_RE = /^[A-Za-z0-9+/\s]+={0,2}$/;

function decodeIfImage(value: string): { bytes: Uint8Array; format: ImageFormat } | null {
  let b64 = value;
  const m = value.match(/^data:([a-z]+\/[a-z0-9.+-]+)?;base64,(.*)$/is);
  if (m) { b64 = m[2]; }
  b64 = b64.replace(/\s+/g, '');
  if (b64.length < 64 || !BASE64_RE.test(b64)) { return null; }
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(Buffer.from(b64, 'base64')); } catch { return null; }
  const format = detectFormat(bytes);
  return format ? { bytes, format } : null;
}

/**
 * Walk a parsed JSON response and collect every base64-encoded image (raw
 * base64 strings or data: URIs) so api_request can write them to files instead
 * of dumping megabytes of base64 into the model's context.
 */
export function extractEmbeddedImages(json: any, maxImages = 64): EmbeddedImage[] {
  const out: EmbeddedImage[] = [];
  const visit = (node: any, path: string, setter: (v: any) => void, depth: number): void => {
    if (out.length >= maxImages || depth > 8) { return; }
    if (typeof node === 'string') {
      if (node.length < 64) { return; }
      const dec = decodeIfImage(node);
      if (dec) { out.push({ jsonPath: path, bytes: dec.bytes, format: dec.format, replace: note => setter(note) }); }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, `${path}[${i}]`, nv => { node[i] = nv; }, depth + 1));
      return;
    }
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        visit(node[k], path ? `${path}.${k}` : k, nv => { node[k] = nv; }, depth + 1);
      }
    }
  };
  visit(json, '', () => { /* root replaced: ignore */ }, 0);
  return out;
}

/** A safe file-name stem derived from a JSON path: `images[2].base64` → `images_2`. */
export function stemFromJsonPath(jsonPath: string, index: number): string {
  const cleaned = jsonPath
    .replace(/\.(base64|data|image|b64|content)$/i, '')
    .replace(/\[(\d+)\]/g, '_$1')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || `image_${index}`;
}

/**
 * Shrink a JSON value for display: long strings are summarized (they are
 * usually base64 blobs the model must not read), and the pretty-printed
 * result is capped at `maxChars`.
 */
export function compactJson(json: any, maxChars = 8000, maxString = 300): string {
  const shrink = (node: any, depth: number): any => {
    if (typeof node === 'string') {
      return node.length > maxString ? `<string of ${node.length} chars: ${node.slice(0, 60)}…>` : node;
    }
    if (Array.isArray(node)) {
      if (depth > 10) { return `<array of ${node.length}>`; }
      const arr = node.slice(0, 100).map(v => shrink(v, depth + 1));
      if (node.length > 100) { arr.push(`<… ${node.length - 100} more items>`); }
      return arr;
    }
    if (node && typeof node === 'object') {
      if (depth > 10) { return '<object>'; }
      const o: Record<string, any> = {};
      for (const [k, v] of Object.entries(node)) { o[k] = shrink(v, depth + 1); }
      return o;
    }
    return node;
  };
  let text: string;
  try { text = JSON.stringify(shrink(json, 0), null, 2); } catch { text = String(json); }
  if (text.length > maxChars) { text = text.slice(0, maxChars) + `\n… (truncated, ${text.length} chars total)`; }
  return text;
}

/** Read a dotted/bracketed path (`data.status`, `jobs[0].state`) from a JSON value. */
export function getPath(json: any, dotted: string): any {
  if (!dotted) { return json; }
  const parts = dotted.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = json;
  for (const p of parts) {
    if (cur === null || cur === undefined) { return undefined; }
    cur = cur[p];
  }
  return cur;
}

/**
 * Likely locations of a machine-readable spec for a site or API base URL.
 * Ordered most-specific first; the caller fetches them and keeps whatever
 * parses. `input` may be a bare domain, a site, an API base, or a docs page.
 */
export function specUrlCandidates(input: string): string[] {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) { raw = 'https://' + raw; }
  let u: URL;
  try { u = new URL(raw); } catch { return []; }
  const origin = u.origin;
  const base = raw.replace(/\/+$/, '').replace(/\/(docs|redoc|swagger|swagger-ui|api-docs)(\/.*)?$/i, '');
  const hosts = new Set<string>([origin]);
  const bareHost = u.hostname.replace(/^www\./, '');
  if (!/^api\./i.test(u.hostname)) {
    hosts.add(`${u.protocol}//api.${bareHost}`);
  }
  const files = ['openapi.json', 'swagger.json', 'api-docs', 'openapi/v1.json', 'swagger/v1/swagger.json', 'docs/openapi.json', '.well-known/openapi.json'];
  const versions = ['', 'v1', 'v2', 'v3', 'api', 'api/v1', 'api/v2'];
  const out: string[] = [];
  const push = (s: string) => { if (!out.includes(s)) { out.push(s); } };
  // 1. relative to the exact base the user gave (e.g. https://api.x.com/v2)
  if (base !== origin) { for (const f of files.slice(0, 3)) { push(`${base}/${f}`); } }
  // 2. per host × version × file
  for (const h of hosts) {
    for (const v of versions) {
      for (const f of files) { push(`${h}/${v ? v + '/' : ''}${f}`); }
    }
  }
  return out.slice(0, 120);
}

/** Spec links found in a docs page / llms.txt / homepage HTML. */
export function specLinksInText(text: string, pageUrl: string): string[] {
  const out = new Set<string>();
  const re = /(?:href=["']|\()?((?:https?:)?\/\/[^\s"'()<>]+|\/[^\s"'()<>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const cand = m[1];
    if (!/openapi|swagger|api-docs|\.json\b/i.test(cand)) { continue; }
    if (/\.(png|jpe?g|gif|svg|css|js|map)(\?|$)/i.test(cand)) { continue; }
    try { out.add(new URL(cand, pageUrl).toString()); } catch { /* skip */ }
  }
  return [...out].slice(0, 20);
}
