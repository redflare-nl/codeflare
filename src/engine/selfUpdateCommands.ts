import * as vscode from 'vscode';
import * as path from 'path';
import { ChatViewProvider } from '../chat/chatViewProvider';
import { getConfig } from '../utils/config';
import { PreparedSelfUpdate, SelfUpdateService, acknowledgeSelfUpdate } from './selfUpdate';

/** User commands own activation; the model's ordinary shell tools do not. */
export function registerSelfUpdateCommands(context: vscode.ExtensionContext, chat: ChatViewProvider): void {
  const storagePath = path.join(context.globalStorageUri.fsPath, 'self-updates');
  let updating = false;
  const service = () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root || root.scheme !== 'file') { throw new Error('Open the local CodeFlare source repository first.'); }
    const config = getConfig();
    return new SelfUpdateService({
      sourceRoot: root.fsPath, installedExtensionPath: context.extensionUri.fsPath, storagePath,
      knownGoodVsix: config.selfUpdateKnownGoodVsix || undefined, executable: config.selfUpdateCli,
      // A candidate that changed the runtime's own guardrails is never activated
      // on the model's say-so; the operator sees exactly which files and decides.
      approveGuardrailChanges: async files => {
        const choice = await vscode.window.showWarningMessage(
          `This CodeFlare candidate changes ${files.length} guardrail file(s) — the policy, evidence, isolation or self-update code that constrains the agent.`,
          { modal: true, detail: `${files.join('\n')}\n\nOnly approve if you reviewed these changes yourself.` },
          'Approve guardrail changes',
        );
        return choice === 'Approve guardrail changes';
      },
      beforeReload: () => chat.prepareForReload(),
      reload: async () => { await vscode.commands.executeCommand('workbench.action.reloadWindow'); },
      progress: (status, detail) => chat.reportSelfUpdate(status, detail),
    });
  };
  const guarded = (work: () => Promise<void>) => async () => {
    if (updating || chat.isBusy) { vscode.window.showInformationMessage('CodeFlare: finish or stop the active task before updating.'); return; }
    updating = true;
    try { await work(); }
    catch (error: any) {
      chat.cancelPreparedReload();
      chat.reportSelfUpdate('failed', error.message);
      vscode.window.showErrorMessage(`CodeFlare: ${error.message}`);
    } finally { updating = false; }
  };
  const prepare = async () => {
    const candidate = await service().prepare();
    await context.workspaceState.update('preparedSelfUpdate', candidate);
    vscode.window.showInformationMessage(`CodeFlare candidate validated: ${candidate.candidateVsix}. Use Activate Validated Self-update to install it.`);
    return candidate;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('codeflare.resumeMission', () => chat.resumeMission()),
    vscode.commands.registerCommand('codeflare.reloadSafely', guarded(async () => {
      await chat.prepareForReload();
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    })),
    vscode.commands.registerCommand('codeflare.prepareSelfUpdate', guarded(async () => { await prepare(); })),
    vscode.commands.registerCommand('codeflare.activateSelfUpdate', guarded(async () => {
      const candidate = context.workspaceState.get<PreparedSelfUpdate>('preparedSelfUpdate');
      if (!candidate) { throw new Error('Prepare and validate a candidate first.'); }
      await service().activate(candidate);
    })),
    vscode.commands.registerCommand('codeflare.improveSelf', guarded(async () => {
      const mode = getConfig().selfImprovement;
      if (mode === 'off') { throw new Error('Self-improvement is disabled in CodeFlare settings.'); }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) { throw new Error('Open the CodeFlare source repository first.'); }
      const pkg = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'package.json'))));
      if (pkg.name !== 'codeflare' || pkg.publisher !== 'local') { throw new Error('Self-improvement runs in the CodeFlare source workspace. Open that project first.'); }
      const request = await vscode.window.showInputBox({
        title: 'Improve CodeFlare', prompt: 'What should CodeFlare improve about itself?',
        placeHolder: 'Example: diagnose and reduce repeated failed edits', ignoreFocusOut: true,
        validateInput: value => value.trim() ? undefined : 'Describe the intended improvement.',
      });
      if (!request) { return; }
      await chat.improveSelf(request);
      if (!chat.missionCompleted) {
        chat.reportSelfUpdate('paused', 'The improvement task needs more work. Resume it before preparing an update.');
        return;
      }
      const candidate = await prepare();
      if (mode === 'automatic') { await service().activate(candidate); }
    })),
  );
}

export async function acknowledgeRegisteredSelfUpdate(context: vscode.ExtensionContext): Promise<void> {
  const acknowledged = await acknowledgeSelfUpdate(path.join(context.globalStorageUri.fsPath, 'self-updates'), context.extensionUri.fsPath);
  if (acknowledged) { vscode.window.showInformationMessage('CodeFlare: updated version started successfully. Saved missions can be resumed.'); }
}
