'use strict';

// Loaded by an isolated VS Code Extension Development Host. This runner is
// taken from the stable installation, so a candidate cannot weaken its checks.
const REQUIRED_COMMANDS = [
  'codeflare.openChat',
  'codeflare.resumeMission',
  'codeflare.prepareSelfUpdate',
  'codeflare.memoryStatus',
];

async function verifyRegistration(vscode) {
  const extension = vscode.extensions.getExtension('local.codeflare');
  if (!extension) { throw new Error('The isolated host did not discover local.codeflare.'); }
  await extension.activate();
  if (!extension.isActive) { throw new Error('CodeFlare did not finish activation.'); }
  const commands = await vscode.commands.getCommands(true);
  const missing = REQUIRED_COMMANDS.filter(command => !commands.includes(command));
  if (missing.length) { throw new Error(`CodeFlare activation did not register: ${missing.join(', ')}`); }
  return extension;
}

async function run() {
  const extension = await verifyRegistration(require('vscode'));
  const memory = await require('vscode').commands.executeCommand('codeflare.memoryStatus', { quiet: true });
  if (!memory?.ready || memory.backend !== 'sqlite') { throw new Error('The bundled SQLite memory service did not initialize.'); }
  const resultFile = process.env.CODEFLARE_SELF_UPDATE_SMOKE_RESULT;
  if (resultFile) {
    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');
    const bundle = fs.readFileSync(path.join(extension.extensionPath, 'dist', 'extension.js'));
    fs.writeFileSync(resultFile, JSON.stringify({
      nonce: process.env.CODEFLARE_SELF_UPDATE_SMOKE_NONCE,
      bundleSha256: crypto.createHash('sha256').update(bundle).digest('hex'),
      extensionPath: extension.extensionPath,
      checkedCommands: REQUIRED_COMMANDS,
    }));
  }
}
module.exports = { run, verifyRegistration, REQUIRED_COMMANDS };
