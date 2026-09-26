import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { deflateRawSync } from 'zlib';
import { spawn } from 'child_process';
import { SelfUpdateService, acknowledgeSelfUpdate, SelfUpdateCommand } from '../src/engine/selfUpdate';
import { inspectCodeFlareVsix, sha256 } from '../src/engine/selfUpdateArchive';

const recovery = require('../scripts/self-update-recovery.cjs');
const roots: string[] = [];
function temporary(): string { const dir = mkdtempSync(path.join(tmpdir(), 'cf-self-update-')); roots.push(dir); return dir; }
afterEach(async () => { for (const root of roots.splice(0)) { await fs.rm(root, { recursive: true, force: true }); } });

/** Stored ZIP builder: exercises the parser without introducing a ZIP dependency. */
function zip(entries: Array<[string, string]>, compress = false): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name);
    const data = Buffer.from(text);
    const compressed = compress ? deflateRawSync(data) : data;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(compress ? 8 : 0, 8);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(compress ? 8 : 0, 10);
    directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename); offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function vsix(bundle = 'module.exports = 1;', overrides = {}): Buffer {
  return zip([
    ['extension/package.json', JSON.stringify({ publisher: 'local', name: 'codeflare', version: '1.0.0', main: './dist/extension.js', ...overrides })],
    ['extension/dist/extension.js', bundle],
  ]);
}

const GUARDRAIL = 'src/engine/policy.ts';
const GUARDRAIL_BASELINE = 'export const BUDGET = 8; // committed\n';
const ANCHOR_COMMIT = 'b'.repeat(40);

interface FixtureOptions {
  /** Candidate content of the guardrail file (default: identical to the committed baseline). */
  guardrail?: string;
  /** Record a healthy prior update anchored at ANCHOR_COMMIT, with this guardrail content there. */
  anchorGuardrail?: string;
  /** Make the anchor commit unresolvable in the repository (git cat-file fails). */
  anchorMissing?: boolean;
}

async function fixture(opts: FixtureOptions = {}) {
  const root = temporary();
  const sourceRoot = path.join(root, 'source');
  const storagePath = path.join(root, 'updates');
  const installedExtensionPath = path.join(root, 'installed');
  await fs.mkdir(path.join(installedExtensionPath, 'dist'), { recursive: true });
  for (const name of ['self-update-recovery.cjs', 'self-update-smoke.cjs']) {
    await fs.copyFile(path.resolve('scripts', name), path.join(installedExtensionPath, 'dist', name));
  }
  await fs.mkdir(path.join(sourceRoot, 'test'), { recursive: true });
  const source: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'codeflare', publisher: 'local', version: '1.0.0', scripts: { postpackage: 'should never run' } }),
    'package-lock.json': '{}',
    'test/baseline.test.ts': 'candidate has deleted the assertion',
    'vitest.config.mts': 'candidate config excludes baseline tests',
    'tsconfig.json': '{}',
    'esbuild.js': 'build',
    // A guardrail file travels with the candidate; CRLF here vs LF in git must not count as a change.
    [GUARDRAIL]: (opts.guardrail ?? GUARDRAIL_BASELINE).replace(/\n/g, '\r\n'),
  };
  for (const [name, contents] of Object.entries(source)) {
    await fs.mkdir(path.dirname(path.join(sourceRoot, name)), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, name), contents);
  }
  const baseline: Record<string, string> = {
    'test/baseline.test.ts': 'the original assertion must remain',
    'vitest.config.mts': 'baseline test config', 'tsconfig.json': '{}',
    [GUARDRAIL]: GUARDRAIL_BASELINE,
  };
  const anchor: Record<string, string> = { ...baseline, [GUARDRAIL]: opts.anchorGuardrail ?? GUARDRAIL_BASELINE };
  if (opts.anchorGuardrail !== undefined || opts.anchorMissing) {
    // A prior update that reached startup health: its source commit is the trusted anchor.
    const id = `${Date.now()}-${'c'.repeat(12)}`;
    await fs.mkdir(path.join(storagePath, id), { recursive: true });
    await fs.writeFile(path.join(storagePath, 'active-update.json'), JSON.stringify({ status: 'healthy', id }));
    await fs.writeFile(path.join(storagePath, id, 'prepared.json'), JSON.stringify({ baselineCommit: ANCHOR_COMMIT }));
  }
  const calls: SelfUpdateCommand[] = [];
  let mutateDuringBuild = false;
  let failTests = false;
  let skipSmokeResult = false;
  let replacePackagedBundle = false;
  const run = async (command: SelfUpdateCommand): Promise<Buffer> => {
    calls.push(command);
    const args = command.args;
    if (command.executable === 'git') {
      if (args[0] === 'rev-parse') { return Buffer.from(args[1] === 'HEAD' ? 'a'.repeat(40) : sourceRoot); }
      if (args[0] === 'ls-files') { return Buffer.from(Object.keys(source).join('\0') + '\0'); }
      if (args[0] === 'ls-tree') {
        // Honour the `-- path…` filter like real git, or the baseline-restore loop
        // would overwrite candidate files outside test/ and hide guardrail edits.
        const filters = args.slice(args.indexOf('--') + 1);
        const listed = Object.keys(baseline).filter(k => filters.some(f => k === f || k.startsWith(f + '/')));
        return Buffer.from(listed.join('\0') + '\0');
      }
      if (args[0] === 'show') {
        const [commit, file] = args[1].split(':');
        const store = commit === ANCHOR_COMMIT ? anchor : baseline;
        if (!(file in store)) { throw new Error(`fatal: path '${file}' does not exist in '${commit}'`); }
        return Buffer.from(store[file]);
      }
      if (args[0] === 'cat-file') {
        if (opts.anchorMissing) { throw new Error('fatal: Not a valid object name'); }
        return Buffer.alloc(0);
      }
    }
    if (args[1] === 'ci') {
      const dir = path.join(command.cwd, 'node_modules/@vscode/vsce');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ bin: { vsce: './vsce' } }));
    }
    if (args[0].includes('vitest.mjs')) {
      expect(await fs.readFile(path.join(command.cwd, 'test/baseline.test.ts'), 'utf8')).toBe(baseline['test/baseline.test.ts']);
      expect(await fs.readFile(path.join(command.cwd, 'vitest.config.mts'), 'utf8')).toBe(baseline['vitest.config.mts']);
      if (failTests) { throw new Error('baseline test failed'); }
    }
    if (args[0] === 'esbuild.js') {
      await fs.mkdir(path.join(command.cwd, 'dist'), { recursive: true });
      await fs.writeFile(path.join(command.cwd, 'dist/extension.js'), 'candidate bundle');
      if (mutateDuringBuild) { await fs.writeFile(path.join(command.cwd, 'test/baseline.test.ts'), 'weakened assertion'); }
    }
    if (args.includes('--extensionTestsPath') && !skipSmokeResult) {
      await fs.writeFile(command.env!.CODEFLARE_SELF_UPDATE_SMOKE_RESULT!, JSON.stringify({
        nonce: command.env!.CODEFLARE_SELF_UPDATE_SMOKE_NONCE,
        bundleSha256: sha256('candidate bundle'), extensionPath: command.cwd,
      }));
    }
    if (args[1] === 'package') {
      expect(JSON.parse(await fs.readFile(path.join(command.cwd, 'package.json'), 'utf8')).scripts).toBeUndefined();
      await fs.writeFile(args[args.indexOf('--out') + 1], vsix(replacePackagedBundle ? 'changed after smoke' : 'candidate bundle'));
    }
    return Buffer.alloc(0);
  };
  const options = { sourceRoot, storagePath, installedExtensionPath, run, executable: process.execPath };
  return {
    ...options, calls, service: new SelfUpdateService(options), setMutation: () => { mutateDuringBuild = true; },
    setTestFailure: () => { failTests = true; }, skipSmoke: () => { skipSmokeResult = true; }, replaceBundle: () => { replacePackagedBundle = true; },
  };
}

describe('self-update guardrail backstop', () => {
  it('passes when guardrail files equal the committed baseline (line endings ignored) and records the check', async () => {
    const f = await fixture();
    const candidate = await f.service.prepare();
    expect(candidate.checks[0]).toMatch(/^Guardrail files unchanged since the committed baseline/);
  });

  it('refuses a candidate whose guardrail file differs from the baseline when nobody can approve', async () => {
    const f = await fixture({ guardrail: 'export const BUDGET = 800; // loosened by the agent\n' });
    await expect(f.service.prepare()).rejects.toThrow(/Self-update refused: guardrail file\(s\) changed since the committed baseline.*src\/engine\/policy\.ts/);
    // Refused BEFORE dependencies were installed or tests ran: the refusal is cheap.
    expect(f.calls.some(c => c.args[1] === 'ci')).toBe(false);
    expect(f.calls.some(c => c.args[0]?.includes?.('vitest.mjs'))).toBe(false);
  });

  it('refuses when the operator declines, proceeds and records approval when they accept', async () => {
    const declined = await fixture({ guardrail: 'changed\n' });
    await expect(new SelfUpdateService({ ...declined, approveGuardrailChanges: async () => false }).prepare())
      .rejects.toThrow(/not approved by the operator/);

    const asked: string[][] = [];
    const accepted = await fixture({ guardrail: 'changed\n' });
    const candidate = await new SelfUpdateService({ ...accepted, approveGuardrailChanges: async files => { asked.push(files); return true; } }).prepare();
    expect(asked).toEqual([[GUARDRAIL]]);
    expect(candidate.checks[0]).toBe(`Guardrail changes approved by the operator: ${GUARDRAIL}`);
  });

  it('catches a guardrail edit the agent managed to COMMIT, by comparing against the last healthy update', async () => {
    // HEAD (baseline) already contains the edit, so a HEAD-only comparison would pass.
    // The anchor still holds the pre-edit content and exposes it.
    const f = await fixture({ guardrail: GUARDRAIL_BASELINE, anchorGuardrail: 'export const BUDGET = 1; // what the operator last activated\n' });
    await expect(f.service.prepare()).rejects.toThrow(/changed since the last healthy update \(bbbbbbbb\)/);
  });

  it('falls back to the committed baseline when the anchor commit is gone from the repository', async () => {
    const f = await fixture({ anchorGuardrail: 'irrelevant\n', anchorMissing: true });
    const candidate = await f.service.prepare();
    expect(candidate.checks[0]).toMatch(/unchanged since the committed baseline/);
  });
});

describe('self-update candidate validation', () => {
  it('runs fixed checks in a separate snapshot, preserves committed assertions and does not install', async () => {
    const f = await fixture();
    const candidate = await f.service.prepare();
    expect(candidate.improvementProven).toBe(false);
    // Guardrail check first, then type check, tests, build/package and smoke.
    expect(candidate.checks).toHaveLength(6);
    expect(candidate.checks[0]).toMatch(/^Guardrail files unchanged/);
    expect(candidate.snapshotPath).not.toBe(f.sourceRoot);
    expect(candidate.candidateSha256).toBe(sha256(await fs.readFile(candidate.candidateVsix)));
    expect(f.calls.find(call => call.args[1] === 'ci')?.args).toContain('--ignore-scripts');
    expect(f.calls.some(call => call.args.includes('--install-extension'))).toBe(false);
    const smoke = f.calls.find(call => call.args.includes('--extensionTestsPath'))!;
    expect(smoke.args).toContain('--disable-extensions');
    expect(smoke.args[smoke.args.indexOf('--user-data-dir') + 1]).toContain(f.storagePath);
    expect(smoke.args[smoke.args.indexOf('--extensions-dir') + 1]).toContain(f.storagePath);
    expect(await fs.readFile(path.join(f.sourceRoot, 'test/baseline.test.ts'), 'utf8')).toContain('candidate has deleted');
    expect(await fs.readFile(path.join(candidate.snapshotPath, 'test/baseline.test.ts'), 'utf8')).toContain('original assertion');
  });

  it('does not package after failed tests', async () => {
    const f = await fixture(); f.setTestFailure();
    await expect(f.service.prepare()).rejects.toThrow('baseline test failed');
    expect(f.calls.some(call => call.args[1] === 'package')).toBe(false);
  });

  it('rejects source/test mutations during the candidate build', async () => {
    const f = await fixture(); f.setMutation();
    await expect(f.service.prepare()).rejects.toThrow('changed during validation');
  });

  it('rejects a successful CLI exit without Extension Host success evidence', async () => {
    const f = await fixture(); f.skipSmoke();
    await expect(f.service.prepare()).rejects.toThrow('did not report successful activation');
    expect(f.calls.some(call => call.args[1] === 'package')).toBe(false);
  });

  it('rejects a package whose bundle differs from the one exercised in the Extension Host', async () => {
    const f = await fixture(); f.replaceBundle();
    await expect(f.service.prepare()).rejects.toThrow('does not match the smoke-tested candidate');
  });

  it('blocks changed packages and activation without a known-good package', async () => {
    const f = await fixture(); const candidate = await f.service.prepare();
    await expect(f.service.activate(candidate)).rejects.toThrow('selfUpdateKnownGoodVsix');
    await fs.writeFile(candidate.candidateVsix, vsix('untested replacement'));
    await expect(f.service.activate(candidate)).rejects.toThrow('changed after validation');
    expect(f.calls.some(call => call.args.includes('--install-extension'))).toBe(false);
  });

  it('requires the known-good bundle to match the running installation', async () => {
    const f = await fixture(); const candidate = await f.service.prepare();
    const knownGoodVsix = path.join(f.storagePath, 'old.vsix');
    await fs.writeFile(knownGoodVsix, vsix('other bundle'));
    await fs.mkdir(path.join(f.installedExtensionPath, 'dist'), { recursive: true });
    await fs.writeFile(path.join(f.installedExtensionPath, 'package.json'), JSON.stringify({ publisher: 'local', name: 'codeflare' }));
    await fs.writeFile(path.join(f.installedExtensionPath, 'dist/extension.js'), 'running bundle');
    await expect(new SelfUpdateService({ ...f, knownGoodVsix }).activate(candidate)).rejects.toThrow('match the currently installed');
  });
});

describe('VSIX identity and startup health', () => {
  it('reads deflated VSIX entries and hashes the uncompressed extension bundle', async () => {
    const file = path.join(temporary(), 'compressed.vsix');
    await fs.writeFile(file, zip([
      ['extension/package.json', JSON.stringify({ publisher: 'local', name: 'codeflare', version: '1', main: './dist/extension.js' })],
      ['extension/dist/extension.js', 'deflated extension bundle'],
    ], true));
    expect((await inspectCodeFlareVsix(file)).bundleSha256).toBe(sha256('deflated extension bundle'));
  });

  it('rejects another extension and duplicate bundle entries', async () => {
    const file = path.join(temporary(), 'candidate.vsix');
    await fs.writeFile(file, vsix('bundle', { name: 'other' }));
    await expect(inspectCodeFlareVsix(file)).rejects.toThrow('local.codeflare');
    await fs.writeFile(file, zip([
      ['extension/package.json', JSON.stringify({ publisher: 'local', name: 'codeflare', version: '1', main: './dist/extension.js' })],
      ['extension/dist/extension.js', 'first'], ['extension/dist/extension.js', 'second'],
    ]));
    await expect(inspectCodeFlareVsix(file)).rejects.toThrow('Duplicate');
  });

  it('acknowledges only a completed startup of the exact candidate bundle', async () => {
    const root = temporary(); const id = '123-abcdef123456';
    await fs.mkdir(path.join(root, id)); await fs.mkdir(path.join(root, 'installed/dist'), { recursive: true });
    const ackPath = path.join(root, id, 'healthy.json');
    const state = { id, nonce: 'secret', status: 'awaiting-health', deadline: Date.now() + 10000, ackPath, candidateBundleSha256: sha256('new bundle') };
    await fs.writeFile(path.join(root, 'active-update.json'), JSON.stringify(state));
    await fs.writeFile(path.join(root, 'installed/dist/extension.js'), 'old bundle');
    expect(await acknowledgeSelfUpdate(root, path.join(root, 'installed'))).toBe(false);
    await fs.writeFile(path.join(root, 'installed/dist/extension.js'), 'new bundle');
    expect(await acknowledgeSelfUpdate(root, path.join(root, 'installed'))).toBe(true);
    expect(JSON.parse(await fs.readFile(ackPath, 'utf8')).nonce).toBe('secret');
  });
});

describe('independent recovery helper', () => {
  it('runs independently, announces readiness and exits after a valid startup acknowledgement', async () => {
    const root = temporary();
    const candidateVsix = path.join(root, 'candidate.vsix');
    const knownGoodVsix = path.join(root, 'known-good.vsix');
    await fs.writeFile(candidateVsix, 'candidate'); await fs.writeFile(knownGoodVsix, 'stable');
    const stateFile = path.join(root, 'state.json');
    const state = {
      id: 'independent', nonce: 'unique-ack', status: 'awaiting-health', executable: process.execPath,
      deadline: Date.now() + 30000, candidateVsix, candidateSha256: sha256('candidate'),
      candidateBundleSha256: 'bundle', knownGoodVsix, knownGoodSha256: sha256('stable'),
      readyPath: path.join(root, 'ready'), ackPath: path.join(root, 'ack.json'),
    };
    await fs.writeFile(stateFile, JSON.stringify(state));
    const child = spawn(process.execPath, [path.resolve('scripts/self-update-recovery.cjs'), stateFile], { windowsHide: true, shell: false, stdio: 'ignore' });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    try {
      let ready = '';
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        try { ready = await fs.readFile(state.readyPath, 'utf8'); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      expect(ready).toBe(state.nonce);
      await fs.writeFile(state.ackPath, JSON.stringify({ id: state.id, nonce: state.nonce, bundleSha256: state.candidateBundleSha256 }));
      expect(await exited).toBe(0);
      expect(JSON.parse(await fs.readFile(stateFile, 'utf8')).status).toBe('healthy');
    } finally {
      if (child.exitCode === null) { child.kill(); }
      await exited;
    }
  });

  function recoveryState() {
    const root = temporary(); const knownGoodVsix = path.join(root, 'known good & old.vsix');
    writeFileSync(knownGoodVsix, 'known-good');
    const state = { id: 'id', nonce: 'nonce', status: 'awaiting-health', executable: process.execPath, deadline: 100, knownGoodVsix, knownGoodSha256: sha256('known-good'), candidateBundleSha256: 'candidate', ackPath: path.join(root, 'ack.json') };
    const file = path.join(root, 'state.json'); writeFileSync(file, JSON.stringify(state));
    return { file, state };
  }

  it('waits until the deadline and then reinstalls the preserved VSIX using separate arguments', () => {
    const { file, state } = recoveryState(); const runner = vi.fn(() => ({ status: 0 }));
    expect(recovery.recover(file, { now: 99, runner })).toBe('waiting'); expect(runner).not.toHaveBeenCalled();
    expect(recovery.recover(file, { now: 101, runner })).toBe('rolled-back');
    expect(runner.mock.calls[0][1]).toContain(state.knownGoodVsix);
    expect(runner.mock.calls[0][2]).toMatchObject({ shell: false, windowsHide: true });
    expect(JSON.parse(readFileSync(file, 'utf8')).detail).toContain('Reload');
  });

  it('keeps a healthy candidate and refuses a corrupted rollback artifact', () => {
    const { file, state } = recoveryState(); const runner = vi.fn(() => ({ status: 0 }));
    writeFileSync(state.ackPath, JSON.stringify({ id: state.id, nonce: state.nonce, bundleSha256: state.candidateBundleSha256 }));
    expect(recovery.recover(file, { now: 101, runner })).toBe('healthy'); expect(runner).not.toHaveBeenCalled();
    const bad = recoveryState(); writeFileSync(bad.state.knownGoodVsix, 'changed');
    expect(recovery.recover(bad.file, { now: 101, runner })).toBe('rollback-failed'); expect(runner).not.toHaveBeenCalled();
  });

  it('records a failed restore and rejects arbitrary Windows batch wrappers', () => {
    const { file } = recoveryState();
    expect(recovery.recover(file, { now: 101, runner: () => ({ status: 1, stderr: 'install failed' }) })).toBe('rollback-failed');
    expect(JSON.parse(readFileSync(file, 'utf8')).detail).toContain('install failed');
    expect(() => recovery.resolveCodeCommand('custom.cmd', 'win32', { PATH: '' })).toThrow('arbitrary batch');
  });
});

describe('stable Extension Host smoke runner', () => {
  const smoke = require('../scripts/self-update-smoke.cjs');
  it('requires completed extension activation and all expected commands', async () => {
    const extension = { isActive: false, activate: vi.fn(async () => { extension.isActive = true; }) };
    const vscode = { extensions: { getExtension: () => extension }, commands: { getCommands: async () => ['codeflare.openChat'] } };
    await expect(smoke.verifyRegistration(vscode)).rejects.toThrow('codeflare.resumeMission');
    vscode.commands.getCommands = async () => [...smoke.REQUIRED_COMMANDS];
    await expect(smoke.verifyRegistration(vscode)).resolves.toBe(extension);
  });
});
