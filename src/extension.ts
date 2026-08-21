import * as vscode from 'vscode';
import { ChatViewProvider } from './chat/chatViewProvider';
import { registerCodeActions } from './editor/codeActions';
import { registerActiveEditorTracker } from './editor/contextGatherer';
import { getPreviewProvider } from './editor/editApplier';
import { VLLMClient } from './llm/client';
import { initSecrets } from './utils/secrets';
import { detectCapabilities } from './utils/capabilities';
import { detectContextSize, detectModel } from './utils/serverInfo';
import { initMcp, disposeMcp } from './mcp/client';
import { stopAllServers, initTerminalCapture } from './llm/tools';
import { showMetricsReport } from './utils/metricsReport';
import { getConfig } from './utils/config';
import { log } from './utils/logger';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log('CodeFlare extension activating...');

  // Track the user's last file editor so the agent still knows the "current
  // file" while the chat webview has focus (activeTextEditor is undefined then).
  registerActiveEditorTracker(context);

  // Capture CodeFlare-terminal output (server logs) for read_terminal_output.
  initTerminalCapture(context);

  // VSCode revives the CodeFlare terminal from the previous session WITH its
  // process tree — stray dev servers (python/node) keep running and hold ports
  // and folders. Dispose the leftover terminal so the old session dies clean.
  for (const t of vscode.window.terminals) {
    if (t.name === 'CodeFlare') {
      t.dispose();
      log('Disposed leftover CodeFlare terminal from a previous session (kills stray servers)');
    }
  }

  // Load the optional API token from SecretStorage before any requests.
  await initSecrets(context);

  // Probe the host environment once in the background (non-blocking) so the
  // agent knows which runtimes/test tools exist and whether installs are possible.
  detectCapabilities().catch(err => log(`Capability probe failed: ${err.message}`));

  // Detect the model's context window so we can cap output tokens sensibly.
  detectContextSize(getConfig().endpoint).catch(err => log(`Context probe failed: ${err.message}`));

  // Discover the served model name from the server (local provider) so it need
  // not be typed. Runs before the first request; falls back to the default.
  detectModel(getConfig().endpoint).catch(err => log(`Model probe failed: ${err.message}`));

  // Connect any configured MCP servers (opt-in; no-op when none configured).
  initMcp(getConfig().mcpServers).catch(err => log(`MCP init failed: ${err.message}`));
  context.subscriptions.push({ dispose: () => disposeMcp() });

  // Register the edit preview content provider
  const editPreviewProvider = getPreviewProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      'codeflare-preview',
      editPreviewProvider
    )
  );

  // Create the chat panel provider (opens on the right via editor title icon)
  const version: string = context.extension.packageJSON.version;
  const chatProvider = new ChatViewProvider(context.extensionUri, version, context.workspaceState);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('codeflare.openChat', () => {
      chatProvider.togglePanel();
    }),

    vscode.commands.registerCommand('codeflare.sendSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }
      const text = editor.document.getText(editor.selection);
      if (text) {
        chatProvider.ensurePanel();
        chatProvider.sendSelectionToChat(text);
      }
    }),

    vscode.commands.registerCommand('codeflare.clearChat', () => {
      chatProvider.clearChat();
    }),

    vscode.commands.registerCommand('codeflare.applyEdit', () => {
      // This is triggered from the webview — handled via postMessage
    }),

    vscode.commands.registerCommand('codeflare.checkHealth', async () => {
      const client = new VLLMClient();
      const healthy = await client.checkHealth();
      if (healthy) {
        vscode.window.showInformationMessage('CodeFlare: VLLM server is healthy');
      } else {
        vscode.window.showErrorMessage('CodeFlare: Cannot reach VLLM server');
      }
    }),

    vscode.commands.registerCommand('codeflare.stopServers', () => {
      const n = stopAllServers('stopped via CodeFlare: Stop Agent Servers');
      vscode.window.terminals.find(t => t.name === 'CodeFlare')?.dispose();
      vscode.window.showInformationMessage(
        `CodeFlare: stopped ${n} tracked server(s) and closed the CodeFlare terminal.`
      );
    }),

    vscode.commands.registerCommand('codeflare.metricsReport', () => {
      showMetricsReport().catch(err => log(`Metrics report failed: ${err.message}`));
    }),

    vscode.commands.registerCommand('codeflare.checkEnvironment', async () => {
      const caps = await detectCapabilities();
      vscode.window.showInformationMessage(
        `CodeFlare environment — Python: ${caps.python ? 'yes' : 'no'}, ` +
        `Node: ${caps.node ? 'yes' : 'no'}, git: ${caps.git ? 'yes' : 'no'}, ` +
        `installs: ${caps.online ? 'online' : 'offline'}`
      );
    }),

    vscode.commands.registerCommand('codeflare.proveIt', async () => {
      await vscode.commands.executeCommand('codeflare.chatView.focus');
      chatProvider.proveIt().catch(err => log(`Prove It failed: ${err.message}`));
    }),

    vscode.commands.registerCommand('codeflare.breakMySolution', async () => {
      await vscode.commands.executeCommand('codeflare.chatView.focus');
      chatProvider.breakMySolution().catch(err => log(`Break My Solution failed: ${err.message}`));
    })
  );

  // Register code action commands (right-click menu)
  registerCodeActions(context, chatProvider);

  // Status bar item
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'codeflare.checkHealth';
  statusBarItem.text = '$(flame) CodeFlare';
  statusBarItem.tooltip = 'CodeFlare - Click to check VLLM health';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Periodic health check (every 30s) — updates the status bar AND the chat UI dot.
  const client = new VLLMClient();
  const applyHealth = (healthy: boolean) => {
    statusBarItem.text = healthy
      ? '$(flame) CodeFlare'
      : '$(flame) CodeFlare $(warning)';
    chatProvider.updateHealth(healthy);
  };
  const healthCheck = setInterval(async () => applyHealth(await client.checkHealth()), 30000);
  context.subscriptions.push({ dispose: () => clearInterval(healthCheck) });

  // Initial health check
  client.checkHealth().then(applyHealth);

  // React to config changes without a window reload.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('codeflare.mcpServers')) {
      disposeMcp();
      initMcp(getConfig().mcpServers).catch(err => log(`MCP re-init failed: ${err.message}`));
    }
    if (e.affectsConfiguration('codeflare.endpoint') ||
        e.affectsConfiguration('codeflare.provider') ||
        e.affectsConfiguration('codeflare.model')) {
      detectContextSize(getConfig().endpoint).catch(() => { /* ignore */ });
      detectModel(getConfig().endpoint).catch(() => { /* ignore */ });
    }
  }));

  log('CodeFlare extension activated');
}

export function deactivate(): void {
  // Best-effort cleanup: kill tracked servers and the terminal's process tree
  // so a window close doesn't leave stray python/node processes behind.
  stopAllServers('window closed');
  vscode.window.terminals.find(t => t.name === 'CodeFlare')?.dispose();
  log('CodeFlare extension deactivated');
}
