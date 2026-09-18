/** Minimal `vscode` stub for unit tests — only what loaded modules touch at import time. */
export const workspace = {
  workspaceFolders: undefined as undefined | { uri: { fsPath: string } }[],
  getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
};
export const Uri = { file: (p: string) => ({ fsPath: p, path: p }) };
