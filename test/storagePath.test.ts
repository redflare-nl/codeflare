import { describe, expect, it } from 'vitest';
import { localStoragePath } from '../src/utils/storagePath';

/**
 * The regression this guards: global storage arrives as `vscode-userdata` on a
 * plainly local Windows install, and a `scheme === 'file'` check disabled
 * persistent memory entirely — reported to the user as "memory storage is
 * unavailable in this window" with no way to tell why.
 */

const uri = (scheme: string, fsPath: string) => ({ scheme, fsPath });
const win = process.platform === 'win32';
const absolute = win ? 'C:\\Users\\info\\AppData\\Roaming\\Code\\User\\globalStorage\\local.codeflare'
  : '/home/info/.config/Code/User/globalStorage/local.codeflare';

describe('localStoragePath', () => {
  it('accepts plain file storage', () => {
    expect(localStoragePath(uri('file', absolute))).toBe(absolute);
  });

  it('accepts vscode-userdata — the scheme a local install actually reports', () => {
    expect(localStoragePath(uri('vscode-userdata', absolute))).toBe(absolute);
  });

  it('accepts an unknown scheme that still resolves to an absolute path', () => {
    // A future VS Code scheme behaving like vscode-userdata must not silently
    // disable memory; the path is what decides.
    expect(localStoragePath(uri('vscode-something-new', absolute))).toBe(absolute);
  });

  it('rejects remote and virtual filesystems', () => {
    for (const scheme of ['vscode-remote', 'vscode-vfs', 'vscode-test-web', 'http', 'https']) {
      expect(localStoragePath(uri(scheme, absolute)), scheme).toBeUndefined();
    }
  });

  it('rejects a remote scheme regardless of letter case', () => {
    expect(localStoragePath(uri('VSCode-Remote', absolute))).toBeUndefined();
  });

  it('rejects a relative or empty path', () => {
    expect(localStoragePath(uri('file', 'relative/path'))).toBeUndefined();
    expect(localStoragePath(uri('file', ''))).toBeUndefined();
    expect(localStoragePath(uri('file', '   '))).toBeUndefined();
  });

  it('returns undefined for a missing URI', () => {
    expect(localStoragePath(undefined)).toBeUndefined();
  });

  it('returns undefined when fsPath throws', () => {
    // Some URI providers throw rather than return a path for their scheme.
    const hostile = { scheme: 'weird', get fsPath(): string { throw new Error('no path'); } };
    expect(localStoragePath(hostile)).toBeUndefined();
  });

  it('tolerates a malformed object instead of throwing', () => {
    expect(localStoragePath({ scheme: undefined as unknown as string, fsPath: absolute })).toBeUndefined();
  });
});
