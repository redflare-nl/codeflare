import * as path from 'path';

/**
 * Which extension-storage locations count as "on this machine's filesystem".
 *
 * Testing `scheme === 'file'` is too strict. VS Code hands out `vscode-userdata`
 * for global storage in several configurations (notably a custom user-data
 * directory), and that is an ordinary local directory whose `fsPath` resolves
 * correctly. Rejecting it disabled persistent memory on a plainly local install.
 *
 * So the question is "does this resolve to an absolute path we can use", not
 * "which scheme is it" — while still excluding genuinely remote or virtual
 * filesystems, where a path string looks fine but points at nothing reachable.
 */

/** Schemes known NOT to be the local filesystem, whatever fsPath reports. */
const REMOTE_SCHEMES = new Set([
  'vscode-remote',   // SSH / containers / WSL: the path exists on the remote
  'vscode-vfs',      // GitHub/Azure Repos virtual filesystem
  'vscode-test-web', // web test host
  'http', 'https',   // served, not mounted
]);

/** A URI as much of it as this check needs; `fsPath` may throw for exotic schemes. */
export interface StorageUriLike {
  scheme: string;
  readonly fsPath: string;
}

/**
 * The local filesystem path behind an extension-storage URI, or undefined when
 * the storage is not usable as a local directory. An unknown scheme is accepted
 * only when it yields an absolute path, so a future VS Code scheme that behaves
 * like `vscode-userdata` keeps working instead of silently disabling memory.
 */
export function localStoragePath(uri: StorageUriLike | undefined): string | undefined {
  if (!uri || typeof uri.scheme !== 'string') { return undefined; }
  if (REMOTE_SCHEMES.has(uri.scheme.toLowerCase())) { return undefined; }
  let resolved: string;
  try {
    resolved = uri.fsPath;
  } catch {
    return undefined; // Some providers throw rather than return a path.
  }
  if (typeof resolved !== 'string' || !resolved.trim() || !path.isAbsolute(resolved)) { return undefined; }
  return resolved;
}
