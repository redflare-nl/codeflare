import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { PolicyVerdict } from './policy';

interface Scope {
  id: string;
  owners: Map<string, string>;
  testsOnly: boolean;
  changedFiles: Set<string>;
  root?: string;
}

const scopes = new AsyncLocalStorage<Scope>();

/** Resolve existing parents too, so a new file below a symlink has one identity. */
function physicalPath(file: string): string {
  const tail: string[] = [];
  let current = file;
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...tail.reverse()); }
    catch (error: any) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') { throw error; }
      const parent = path.dirname(current);
      if (parent === current) { return file; }
      tail.push(path.basename(current)); current = parent;
    }
  }
}

export function isTestPath(file: string): boolean {
  const raw = file.replace(/\\/g, '/').trim();
  // Check workspace-relative paths only. A parent folder named "tests" must
  // never turn production files into test files, nor may .. escape this role.
  if (!raw || raw.startsWith('/') || /^[a-z]:/i.test(raw) || raw.split('/').includes('..')) { return false; }
  const p = path.posix.normalize(raw);
  const base = path.posix.basename(p);
  if (/^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.jsonc?|pyproject\.toml|poetry\.lock|requirements(?:[-.][^.]+)?\.txt|setup\.(?:py|cfg)|pytest\.ini|tox\.ini|cargo\.(?:toml|lock)|go\.(?:mod|sum)|pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|gradle\.properties|\.(?:npmrc|yarnrc|mocharc)(?:\.[^.]+)?|tsconfig(?:\.[^.]+)?\.json)$/i.test(base) ||
      /^(?:vitest|vite|jest|playwright|webpack|babel|eslint|karma|cypress|ava)\.config\./i.test(base) ||
      /\.(?:csproj|fsproj|vbproj|sln)$/i.test(base)) { return false; }
  return /(^|\/)(__tests__|tests?|specs?|fixtures|__snapshots__)(\/|$)/i.test(p) ||
    /(^|\/)test_[^/]+\.py$/i.test(p) || /(?:[._-](test|spec)|_test)\.[^/]+$/i.test(p);
}

/** Scope applies to typed file tools; parallel workers have no shell/MCP tools. */
export function withAgentScope<T>(
  id: string, owners: Map<string, string>, testsOnly: boolean,
  changedFiles: Set<string>, work: () => Promise<T>, root?: string
): Promise<T> {
  return scopes.run({ id, owners, testsOnly, changedFiles, root }, work);
}

export function checkAgentMutation(file: string, record: boolean): PolicyVerdict {
  const scope = scopes.getStore();
  if (!scope) { return { allowed: true }; }
  const raw = file.replace(/\\/g, '/').trim();
  const absolute = raw.startsWith('/') || /^[a-z]:/i.test(raw);
  if (!raw || (!scope.root && absolute) || (absolute && !path.isAbsolute(raw))) {
    return { allowed: false, code: 'PATH_NOT_ALLOWED', reason: 'Agent edits require an unambiguous workspace path.' };
  }
  // Use the same resolved workspace identity for relative and absolute aliases.
  let resolved: string;
  let root = scope.root;
  try {
    root = root ? physicalPath(path.resolve(root)) : undefined;
    resolved = scope.root ? physicalPath(path.resolve(scope.root, raw)) : path.posix.normalize(raw);
  } catch {
    return { allowed: false, code: 'PATH_NOT_ALLOWED', reason: 'Cannot establish the real filesystem path for this agent edit.' };
  }
  const relative = root ? path.relative(root, resolved).replace(/\\/g, '/') : resolved;
  if (!relative || relative === '.' || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    return { allowed: false, code: 'PATH_NOT_ALLOWED', reason: 'Agent edits must stay inside the mission workspace.' };
  }
  const key = resolved.replace(/\\/g, '/').toLowerCase();
  if (scope.testsOnly && (raw.split('/').includes('..') || !isTestPath(relative))) {
    return { allowed: false, code: 'PATH_NOT_ALLOWED', reason: 'The test author may only edit test files. Report implementation defects to the coordinator.' };
  }
  const owner = scope.owners.get(key);
  if (owner && owner !== scope.id) {
    return { allowed: false, code: 'PATH_NOT_ALLOWED', reason: `Another parallel agent (${owner}) owns ${file}. Return this dependency to the coordinator; do not overwrite it.` };
  }
  if (record) {
    scope.owners.set(key, scope.id);
    scope.changedFiles.add(relative);
  }
  return { allowed: true };
}
