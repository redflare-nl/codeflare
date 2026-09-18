import * as vscode from 'vscode';
import { log } from './logger';

/**
 * Named credentials for EXTERNAL web services (PixelLab, OpenWeather, …), as
 * opposed to secrets.ts which holds the LLM-provider token. Each service's key
 * lives in VSCode SecretStorage (encrypted, per user, never in settings.json);
 * the non-secret metadata (base URL, spec URL, auth scheme, pinned hosts) is
 * kept alongside it so the agent can call the API by service NAME and never
 * needs to see — or repeat — the key itself.
 *
 * Host pinning: a key is only ever attached to requests whose host matches
 * the service's recorded API host(s). A model that (mistakenly or under
 * prompt injection) points api_request at another domain with service:"x"
 * gets a refusal, not a leaked credential.
 */

export type ServiceAuthScheme = 'bearer' | 'header' | 'query' | 'basic';

export interface ApiServiceMeta {
  name: string;
  /** Absolute API base URL (OpenAPI servers[0]) once known. */
  baseUrl?: string;
  /** Where the OpenAPI document was found. */
  specUrl?: string;
  auth: ServiceAuthScheme;
  /** Header / query-parameter name for header/query schemes. */
  authName?: string;
  /** Value prefix for header schemes (bearer default "Bearer "). */
  authPrefix?: string;
  /** Hosts the credential may be sent to. */
  hosts: string[];
  addedAt: string;
  /** Optional note from the user (what the key is for, plan limits, …). */
  note?: string;
}

const INDEX_KEY = 'codeflare.apiServices';
const keyFor = (name: string) => `codeflare.apiService.${name}`;

let storage: vscode.SecretStorage | undefined;
let index: ApiServiceMeta[] = [];
const keys = new Map<string, string>();

/** Lower-case, trimmed, `[a-z0-9._-]` only — the name is also a storage key. */
export function normalizeServiceName(raw: string): string {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export async function initApiServices(context: vscode.ExtensionContext): Promise<void> {
  storage = context.secrets;
  try {
    const raw = await storage.get(INDEX_KEY);
    index = raw ? (JSON.parse(raw) as ApiServiceMeta[]) : [];
  } catch {
    index = [];
  }
  for (const m of index) {
    keys.set(m.name, (await storage.get(keyFor(m.name))) || '');
  }
  if (index.length) { log(`API services loaded: ${index.map(m => m.name).join(', ')}`); }
}

async function persistIndex(): Promise<void> {
  if (!storage) { return; }
  await storage.store(INDEX_KEY, JSON.stringify(index));
}

export function listApiServices(): ApiServiceMeta[] {
  return index.map(m => ({ ...m, hosts: [...m.hosts] }));
}

export function getApiService(name: string): { meta: ApiServiceMeta; key: string } | undefined {
  const n = normalizeServiceName(name);
  const meta = index.find(m => m.name === n);
  if (!meta) { return undefined; }
  return { meta, key: keys.get(n) || '' };
}

/** Every stored credential value — for redacting tool output. */
export function allServiceSecrets(): string[] {
  return [...keys.values()].filter(Boolean);
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) { return undefined; }
  try { return new URL(url).hostname.toLowerCase(); } catch { return undefined; }
}

/**
 * Create or update a service. `key` undefined = keep the existing one. Any
 * baseUrl/specUrl host is added to the pinned hosts automatically.
 */
export async function upsertApiService(
  patch: Partial<ApiServiceMeta> & { name: string },
  key?: string
): Promise<ApiServiceMeta | { error: string }> {
  const name = normalizeServiceName(patch.name);
  if (!name) { return { error: 'A service needs a name (letters, digits, "-", "_", ".").' }; }
  let meta = index.find(m => m.name === name);
  if (!meta) {
    meta = { name, auth: 'bearer', hosts: [], addedAt: new Date().toISOString() };
    index.push(meta);
  }
  if (patch.baseUrl !== undefined) { meta.baseUrl = patch.baseUrl.replace(/\/+$/, '') || undefined; }
  if (patch.specUrl !== undefined) { meta.specUrl = patch.specUrl || undefined; }
  if (patch.auth) { meta.auth = patch.auth; }
  if (patch.authName !== undefined) { meta.authName = patch.authName || undefined; }
  if (patch.authPrefix !== undefined) { meta.authPrefix = patch.authPrefix; }
  if (patch.note !== undefined) { meta.note = patch.note || undefined; }
  for (const h of [hostOf(meta.baseUrl), hostOf(meta.specUrl), ...(patch.hosts || [])]) {
    const hh = (h || '').toLowerCase();
    if (hh && !meta.hosts.includes(hh)) { meta.hosts.push(hh); }
  }
  if (key !== undefined) {
    keys.set(name, key);
    if (storage) {
      if (key) { await storage.store(keyFor(name), key); } else { await storage.delete(keyFor(name)); }
    }
  }
  await persistIndex();
  return meta;
}

export async function removeApiService(name: string): Promise<boolean> {
  const n = normalizeServiceName(name);
  const i = index.findIndex(m => m.name === n);
  if (i < 0) { return false; }
  index.splice(i, 1);
  keys.delete(n);
  if (storage) { await storage.delete(keyFor(n)); }
  await persistIndex();
  return true;
}

/**
 * May the credential of `meta` be sent to `url`? True when the host equals a
 * pinned host or is a subdomain of one. A service with NO pinned host yet
 * accepts the first host it is used with (and pins it).
 */
export function hostAllowed(meta: ApiServiceMeta, url: string): { ok: true } | { ok: false; reason: string } {
  const host = hostOf(url);
  if (!host) { return { ok: false, reason: `Invalid URL "${url}".` }; }
  if (meta.hosts.length === 0) { return { ok: true }; }
  if (meta.hosts.some(h => host === h || host.endsWith('.' + h))) { return { ok: true }; }
  return {
    ok: false,
    reason: `The "${meta.name}" credential is pinned to ${meta.hosts.join(', ')} and will NOT be sent to ${host}. ` +
      `Call the request without "service" (unauthenticated) if that host needs no key, or store a separate key for it.`,
  };
}

/** Pin an additional host after a successful first use (see hostAllowed). */
export async function pinHost(name: string, url: string): Promise<void> {
  const host = hostOf(url);
  const meta = index.find(m => m.name === normalizeServiceName(name));
  if (!meta || !host || meta.hosts.includes(host)) { return; }
  meta.hosts.push(host);
  await persistIndex();
}

/** One-line-per-service summary for the system prompt and api_services (no secrets). */
export function describeApiServices(): string {
  if (index.length === 0) { return ''; }
  return index.map(m => {
    const parts = [m.name];
    parts.push(keys.get(m.name) ? `key stored (${m.auth}${m.authName ? ' ' + m.authName : ''})` : 'NO key stored');
    if (m.baseUrl) { parts.push(`base ${m.baseUrl}`); }
    parts.push(m.specUrl ? 'spec known' : 'spec not discovered yet');
    if (m.note) { parts.push(m.note.slice(0, 80)); }
    return `- ${parts.join(' — ')}`;
  }).join('\n');
}
