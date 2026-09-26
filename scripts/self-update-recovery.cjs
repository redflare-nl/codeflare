'use strict';

// Deliberately standalone: copied outside the installed extension before an update.
// A broken extension must not prevent this process from restoring its known-good VSIX.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

/** Resolve VS Code's Windows batch shim to its actual CLI, without invoking cmd.exe. */
function resolveCodeCommand(executable = 'code', platform = process.platform, env = process.env) {
  let resolved = executable;
  if (!path.isAbsolute(resolved)) {
    const names = platform === 'win32' && !path.extname(resolved) ? [resolved + '.cmd', resolved + '.exe', resolved] : [resolved];
    for (const dir of (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':')) {
      const found = names.map(name => path.join(dir.replace(/^"|"$/g, ''), name)).find(file => fs.existsSync(file));
      if (found) { resolved = path.resolve(found); break; }
    }
  }
  if (platform === 'win32' && /^Code(?: - Insiders)?\.exe$/i.test(path.basename(resolved))) {
    const shim = path.join(path.dirname(resolved), 'bin', /Insiders/i.test(resolved) ? 'code-insiders.cmd' : 'code.cmd');
    if (fs.existsSync(shim)) { resolved = shim; }
  }
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
    if (!/^code(?:-insiders)?\.cmd$/i.test(path.basename(resolved))) {
      throw new Error('Use the VS Code code.cmd CLI or a native executable; arbitrary batch wrappers are unsupported.');
    }
    const root = path.dirname(path.dirname(resolved));
    let cli = path.join(root, 'resources', 'app', 'out', 'cli.js');
    if (!fs.existsSync(cli)) {
      // New Windows releases put resources under a version/commit directory.
      // Read only this fixed path shape from the official shim; never execute it.
      const relative = fs.readFileSync(resolved, 'utf8').match(/"%~dp0\.\.\\((?:[a-f0-9]{6,64}\\)?resources\\app\\out\\cli\.js)"/i)?.[1];
      if (relative) { cli = path.join(root, ...relative.split('\\')); }
    }
    const binary = ['Code.exe', 'Code - Insiders.exe'].map(name => path.join(root, name)).find(file => fs.existsSync(file));
    if (!binary || !fs.existsSync(cli)) { throw new Error('Cannot resolve the VS Code CLI beside code.cmd. Set codeflare.selfUpdateCli to a native CLI executable.'); }
    return { executable: binary, args: [cli], env: { ...env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' } };
  }
  const cleanEnv = { ...env };
  delete cleanEnv.ELECTRON_RUN_AS_NODE;
  return { executable: resolved, args: [], env: cleanEnv };
}

function installVsix(command, artifact, runner = spawnSync) {
  const result = runner(command.executable, [...command.args, '--install-extension', artifact, '--force'], {
    env: command.env, windowsHide: true, shell: false, timeout: 120000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || `VS Code CLI exited with ${result.status}.`);
  }
}

function matchingAcknowledgement(state) {
  try {
    const ack = JSON.parse(fs.readFileSync(state.ackPath, 'utf8'));
    return ack.id === state.id && ack.nonce === state.nonce && ack.bundleSha256 === state.candidateBundleSha256;
  } catch { return false; }
}

function recover(stateFile, options = {}) {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const now = options.now ?? Date.now();
  if (['healthy', 'rolled-back', 'rollback-failed'].includes(state.status)) { return state.status; }
  if (matchingAcknowledgement(state)) {
    state.status = 'healthy';
    state.detail = 'The installed candidate completed extension activation with the expected bundle hash.';
  } else if (now >= state.deadline) {
    try {
      if (hash(state.knownGoodVsix) !== state.knownGoodSha256) { throw new Error('Known-good VSIX hash changed; refusing to install it.'); }
      installVsix(resolveCodeCommand(state.executable), state.knownGoodVsix, options.runner);
      state.status = 'rolled-back';
      state.detail = 'Known-good VSIX restored. Reload the VS Code window to activate it.';
    } catch (error) {
      state.status = 'rollback-failed';
      state.detail = `Automatic rollback failed: ${error.message}`;
    }
  } else { return 'waiting'; }
  state.finishedAt = new Date(now).toISOString();
  writeJson(stateFile, state);
  return state.status;
}

function launch(stateFile) {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (hash(state.knownGoodVsix) !== state.knownGoodSha256 || hash(state.candidateVsix) !== state.candidateSha256) {
    throw new Error('An update artifact changed before the recovery guard started.');
  }
  resolveCodeCommand(state.executable);
  fs.writeFileSync(state.readyPath, state.nonce);
  const timer = setInterval(() => {
    try {
      if (recover(stateFile) !== 'waiting') { clearInterval(timer); }
    } catch (error) {
      fs.appendFileSync(`${stateFile}.log`, `${new Date().toISOString()} ${error.message}\n`);
    }
  }, 1000);
}

module.exports = { hash, writeJson, resolveCodeCommand, installVsix, matchingAcknowledgement, recover, launch };
if (require.main === module) {
  try { launch(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
