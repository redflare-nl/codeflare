import * as vscode from 'vscode';
import { getConfig, Provider } from './config';

/**
 * Stores an optional API token per provider in VSCode SecretStorage (encrypted,
 * per-user) instead of settings.json, so it never lands in synced/committed
 * config. A cached copy is kept so the client can read it synchronously at
 * request time. Keys are per-provider so switching provider doesn't require
 * re-entering the token for the other backend.
 */

const LEGACY_KEY = 'codeflare.apiKey';
const keyFor = (p: Provider) => `codeflare.apiKey.${p}`;
const PROVIDERS: Provider[] = ['local', 'openai', 'anthropic'];

let secretStorage: vscode.SecretStorage | undefined;
const cached: Record<Provider, string> = { local: '', openai: '', anthropic: '' };

function activeProvider(): Provider {
  return getConfig().provider;
}

export async function initSecrets(context: vscode.ExtensionContext): Promise<void> {
  secretStorage = context.secrets;
  for (const p of PROVIDERS) {
    cached[p] = (await secretStorage.get(keyFor(p))) || '';
  }
  // One-time migration: an older single-key install stored the token under
  // `codeflare.apiKey`. Fold it into whichever provider is currently active
  // (defaults to local) if that provider has no per-provider key yet.
  const legacy = await secretStorage.get(LEGACY_KEY);
  if (legacy) {
    const p = activeProvider();
    if (!cached[p]) {
      cached[p] = legacy;
      await secretStorage.store(keyFor(p), legacy);
    }
    await secretStorage.delete(LEGACY_KEY);
  }
}

export function getApiKey(provider: Provider = activeProvider()): string {
  return cached[provider];
}

export function hasApiKey(provider: Provider = activeProvider()): boolean {
  return cached[provider].length > 0;
}

export async function setApiKey(value: string, provider: Provider = activeProvider()): Promise<void> {
  cached[provider] = value || '';
  if (!secretStorage) { return; }
  if (value) {
    await secretStorage.store(keyFor(provider), value);
  } else {
    await secretStorage.delete(keyFor(provider));
  }
}
