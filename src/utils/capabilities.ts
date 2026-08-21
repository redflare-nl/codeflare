import { exec } from 'child_process';
import { getContextSize } from './serverInfo';
import { log } from './logger';

/**
 * A one-time probe of the host environment: which runtimes and test tools are
 * available, and whether package registries are reachable (so the agent knows
 * if it may install missing tools). The result is cached and folded into the
 * system prompt so the model doesn't waste turns trying things that can't work.
 */

export interface Capabilities {
  os: string;
  python?: string;
  node?: string;
  npm?: string;
  npx: boolean;
  pip: boolean;
  git?: string;
  powershell?: string;
  pytest: boolean;
  pester?: string;
  online: boolean;
  probed: boolean;
}

let cached: Capabilities | undefined;

/** Run `cmd` and resolve its first line of output, or null if it fails. */
function probe(cmd: string, timeout = 6000): Promise<string | null> {
  return new Promise(resolve => {
    exec(cmd, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { resolve(null); return; }
      const out = (stdout || stderr || '').trim().split('\n')[0].trim();
      resolve(out);
    });
  });
}

/** True if we can reach a package registry (i.e. installs/downloads are possible). */
async function checkOnline(): Promise<boolean> {
  const urls = ['https://registry.npmjs.org/', 'https://pypi.org/simple/'];
  for (const url of urls) {
    try {
      await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3500) });
      return true;
    } catch {
      // Try the next registry.
    }
  }
  return false;
}

export async function detectCapabilities(): Promise<Capabilities> {
  const isWin = process.platform === 'win32';
  const [python, node, npm, npxV, pipV, git, psV, pytestV, pester, online] = await Promise.all([
    probe('python --version'),
    probe('node --version'),
    probe('npm --version'),
    probe('npx --version'),
    probe('pip --version'),
    probe('git --version'),
    isWin ? probe('powershell -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"') : Promise.resolve(null),
    probe('python -m pytest --version'),
    isWin ? probe('powershell -NoProfile -Command "(Get-Module -ListAvailable Pester | Select-Object -First 1).Version.ToString()"') : Promise.resolve(null),
    checkOnline(),
  ]);

  cached = {
    os: process.platform,
    python: python ?? undefined,
    node: node ?? undefined,
    npm: npm ?? undefined,
    npx: npxV !== null,
    pip: pipV !== null,
    git: git ?? undefined,
    powershell: psV ?? undefined,
    pytest: pytestV !== null,
    pester: pester ?? undefined,
    online,
    probed: true,
  };

  log(`Environment probed: ${getCapabilitiesSummary().replace(/\n/g, ' | ')}`);
  return cached;
}

export function getCapabilities(): Capabilities | undefined {
  return cached;
}

/** Concise, token-cheap summary for the system prompt. Empty until probed. */
export function getCapabilitiesSummary(): string {
  const c = cached;
  if (!c) { return ''; }

  const lines: string[] = ['ENVIRONMENT (probed at startup — trust this, do not re-check):'];
  lines.push(`- OS: ${c.os}`);
  if (c.python) {
    lines.push(`- Python: ${c.python.replace(/^Python\s*/i, '')} (python -m unittest, python -m py_compile available; pytest ${c.pytest ? 'installed' : 'NOT installed'})`);
  } else {
    lines.push('- Python: not available');
  }
  if (c.node) {
    lines.push(`- Node: ${c.node}${c.npm ? `, npm ${c.npm}` : ''}${c.npx ? ', npx available' : ''}`);
  } else {
    lines.push('- Node: not available');
  }
  if (c.powershell) {
    lines.push(`- PowerShell: ${c.powershell}${c.pester ? ` (Pester ${c.pester})` : ' (Pester not installed)'}`);
  }
  lines.push(`- git: ${c.git ? 'available' : 'not available'}`);

  const ctx = getContextSize();
  if (ctx) {
    lines.push(
      `- Model context window: ${ctx} tokens (input + output combined). A single ` +
      `create_file cannot exceed what's left after the prompt — for anything sizeable, ` +
      `write it in small parts (create_file, then edit_file appends).`
    );
  }

  if (c.online) {
    lines.push('- Package installs (internet): ONLINE — you MAY install missing tools (pip install / npm i / Install-Module) after the user confirms the command.');
  } else {
    lines.push('- Package installs (internet): OFFLINE — do NOT run installs or downloads (pip install, npm install, npx of an uninstalled package, Install-Module); they will fail. If a test needs a tool that is not installed, SKIP it and say so instead of guessing.');
  }
  lines.push('Only use runtimes/tools listed as available. Prefer built-ins already present.');

  return lines.join('\n');
}
