import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTool: vi.fn(),
  gateToolCall: vi.fn(),
  clients: [] as object[],
  createWebviewPanel: vi.fn(),
  config: { agentEdit: true, agentRunCommands: true, agentMode: true, agentMaxSteps: 4, metrics: false, diagnosticsMaxRounds: 1, maxParallelAgents: 4 },
}));

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined, getConfiguration: () => ({ get: () => undefined }) }, Uri: { file: (fsPath: string) => ({ fsPath }), joinPath: (base: any, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }) }, ViewColumn: { Two: 2 }, window: { createWebviewPanel: mocks.createWebviewPanel } }));
vi.mock('../src/llm/client', () => ({ VLLMClient: class { abort = vi.fn(); constructor() { mocks.clients.push(this); } } }));
vi.mock('../src/llm/tools', () => ({ executeTool: mocks.executeTool, getToolDefinitions: () => [], describeToolCall: (name: string) => name, copyableCommand: () => undefined, resolveForRead: (p: string) => p, setToolWriteLock: () => undefined }));
vi.mock('../src/llm/prompts', () => ({
  buildSystemPrompt: () => 'system instructions',
  buildMessages: (_system: string, _history: unknown[], user: string) => [{ role: 'user', content: user }],
}));
vi.mock('../src/editor/contextGatherer', () => ({ gatherContext: () => ({ fileName: 'upload.ts' }) }));
vi.mock('../src/editor/editApplier', () => ({}));
vi.mock('../src/editor/probes', () => ({}));
vi.mock('../src/editor/diagnostics', () => ({}));
vi.mock('../src/editor/repoMap', () => ({}));
vi.mock('../src/editor/checkpoint', () => ({}));
vi.mock('../src/stacks/stacks', () => ({}));
vi.mock('../src/mcp/client', () => ({ isMcpTool: () => false }));
vi.mock('../src/utils/projectMemory', () => ({}));
vi.mock('../src/utils/executables', () => ({}));
vi.mock('../src/utils/metrics', () => ({ isMutatingTool: () => false, isWriteFailure: () => false, isUserDecline: () => false, isVerifyLikeCommand: () => false }));
vi.mock('../src/utils/pdf', () => ({}));
vi.mock('../src/utils/config', () => ({ getConfig: () => mocks.config }));
vi.mock('../src/utils/secrets', () => ({}));
vi.mock('../src/utils/serverInfo', () => ({ getContextSize: () => 32768 }));
vi.mock('../src/utils/logger', () => ({ log: vi.fn() }));
vi.mock('../src/engine/runlog', () => ({}));
vi.mock('../src/engine/policyGate', () => ({ gateToolCall: mocks.gateToolCall }));
vi.mock('../src/engine/gitIsolation', () => ({}));

import { readFileSync } from 'fs';
import { ChatViewProvider } from '../src/chat/chatViewProvider';

function fakePanel() {
  const handlers: Record<string, Function> = {};
  const panel: any = {
    webview: {
      options: undefined, html: '', cspSource: 'vscode-resource:',
      asWebviewUri: (u: any) => ({ toString: () => `webview:${u.fsPath}` }),
      onDidReceiveMessage: (h: Function) => { handlers.message = h; return { dispose() {} }; },
      postMessage: vi.fn(),
    },
    onDidDispose: (h: Function) => { handlers.dispose = h; return { dispose() {} }; },
    dispose: vi.fn(() => handlers.dispose?.()),
    reveal: vi.fn(),
  };
  return { panel, handlers };
}

describe('chat panel survives a window reload', () => {
  it('declares an activation event and restores a panel VS Code hands back', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.activationEvents).toContain(`onWebviewPanel:${ChatViewProvider.panelType}`);

    const subject = new ChatViewProvider({ fsPath: 'C:/codeflare-extension' } as any) as any;
    const { panel, handlers } = fakePanel();
    subject.restorePanel(panel);
    expect(subject._panel).toBe(panel);
    expect(panel.webview.options).toMatchObject({ enableScripts: true });
    expect(panel.webview.html).toMatch(/<div id="chat-container">/);
    expect(typeof handlers.message).toBe('function');
    // Closing it afterwards clears the provider's handle, so openChat creates a new one.
    panel.dispose();
    expect(subject._panel).toBeUndefined();
  });

  it('keeps a single chat when two panels are restored', () => {
    const subject = new ChatViewProvider({ fsPath: 'C:/codeflare-extension' } as any) as any;
    const first = fakePanel().panel;
    const second = fakePanel().panel;
    subject.restorePanel(first);
    subject.restorePanel(second);
    expect(subject._panel).toBe(first);
    expect(second.dispose).toHaveBeenCalled();
  });

  it('opens a new panel with the same type the serializer restores', () => {
    const subject = new ChatViewProvider({ fsPath: 'C:/codeflare-extension' } as any) as any;
    mocks.createWebviewPanel.mockReturnValue(fakePanel().panel);
    subject.togglePanel();
    expect(mocks.createWebviewPanel.mock.calls[0][0]).toBe(ChatViewProvider.panelType);
    expect(mocks.createWebviewPanel.mock.calls[0][3]).toMatchObject({ enableScripts: true, retainContextWhenHidden: true });
  });

  it('no longer calls the non-existent codeflare.chatView.focus command', () => {
    for (const f of ['src/extension.ts', 'src/editor/codeActions.ts']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/chatView\.focus/);
    }
  });
});
