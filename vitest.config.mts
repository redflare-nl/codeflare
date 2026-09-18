import { defineConfig } from 'vitest/config';
import * as path from 'path';

// `vscode` only exists inside the extension host. Unit tests import modules that
// are vscode-free in the parts they exercise (e.g. resolveExecutableRoot), so the
// bare import is aliased to a stub to keep the module loadable under vitest.
// .mts so Vite loads this config as ESM (the package has no "type": "module").
export default defineConfig({
  resolve: {
    alias: { vscode: path.resolve(import.meta.dirname, 'test/stubs/vscode.ts') },
  },
});
