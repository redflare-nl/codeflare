import { execFile, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { inspectCodeFlareVsix, sha256 } from './selfUpdateArchive';
import { GUARDRAIL_PATHS } from './policy';

export interface SelfUpdateCommand {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface SelfUpdateOptions {
  sourceRoot: string;
  installedExtensionPath: string;
  storagePath: string;
  /** Explicitly supplied artifact known to work; activation is blocked without it. */
  knownGoodVsix?: string;
  executable?: string;
  beforeReload?: () => Promise<void>;
  reload?: () => Promise<void>;
  progress?: (status: string, detail: string) => void;
  /** Test seam; normal callers should use the real process runner. */
  run?: (command: SelfUpdateCommand) => Promise<Buffer>;
  /**
   * Asked when the candidate's guardrail files differ from the trusted anchor.
   * Absent ⇒ such a candidate is refused. Supplied by the command layer as a
   * modal: guardrail changes need a human decision, never an automatic one.
   */
  approveGuardrailChanges?: (files: string[]) => Promise<boolean>;
}

export interface PreparedSelfUpdate {
  id: string;
  sourceRoot: string;
  snapshotPath: string;
  candidateVsix: string;
  candidateSha256: string;
  candidateBundleSha256: string;
  sourceSha256: string;
  version: string;
  preparedAt: string;
  baselineCommit: string;
  checks: string[];
  /** A successful validation is evidence of compatibility, not benchmark improvement. */
  improvementProven: false;
}

function runProcess(command: SelfUpdateCommand): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(command.executable, command.args, {
      cwd: command.cwd, timeout: command.timeoutMs, encoding: 'buffer', windowsHide: true,
      shell: false, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...command.env },
    }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`${path.basename(command.executable)} ${command.args[0] || ''} failed: ${error.message}\n${stderr.toString().slice(-12000)}\n${stdout.toString().slice(-12000)}`)); }
      else { resolve(stdout); }
    });
  });
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function json(file: string): Promise<any> { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }
async function saveJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, file);
}

async function npmCli(): Promise<string> {
  const roots = [path.dirname(process.execPath), ...(process.env.PATH || process.env.Path || '').split(path.delimiter)];
  for (const root of roots) {
    for (const file of [path.join(root, 'node_modules/npm/bin/npm-cli.js'), path.resolve(root, '../lib/node_modules/npm/bin/npm-cli.js')]) {
      if (await exists(file)) { return file; }
    }
    // Typical Unix npm symlink; Windows npm.ps1 is intentionally never executed.
    try {
      const file = await fs.realpath(path.join(root, 'npm'));
      if (file.endsWith(`${path.sep}npm-cli.js`)) { return file; }
    } catch { /* next PATH entry */ }
  }
  throw new Error('npm CLI was not found. Install Node.js/npm before preparing a self-update.');
}

async function sourceDigest(root: string, files: string[]): Promise<string> {
  const parts: Buffer[] = [];
  for (const file of [...files].sort()) {
    parts.push(Buffer.from(file + '\0'), Buffer.from(sha256(await fs.readFile(path.join(root, file)))));
  }
  return sha256(Buffer.concat(parts));
}

export class SelfUpdateService {
  private readonly execute: (command: SelfUpdateCommand) => Promise<Buffer>;
  constructor(private readonly options: SelfUpdateOptions) { this.execute = options.run || runProcess; }

  private async command(executable: string, args: string[], cwd: string, timeoutMs = 120000, env?: NodeJS.ProcessEnv): Promise<Buffer> {
    return this.execute({ executable, args, cwd, timeoutMs, env });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.options.storagePath, { recursive: true });
    const lockPath = path.join(this.options.storagePath, 'self-update.lock');
    let lock;
    try { lock = await fs.open(lockPath, 'wx'); }
    catch { throw new Error(`Another self-update operation holds ${lockPath}. If VS Code crashed, inspect the recovery state before removing this stale lock.`); }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return await operation();
    } finally { await lock.close(); await fs.unlink(lockPath); }
  }

  private progress(status: string, detail: string): void { this.options.progress?.(status, detail); }

  /** Snapshot the current checkout; never run packaging lifecycle scripts in the user's tree. */
  async prepare(): Promise<PreparedSelfUpdate> {
    return this.withLock(async () => {
      const sourceRoot = await fs.realpath(this.options.sourceRoot);
      const pkg = await json(path.join(sourceRoot, 'package.json'));
      if (pkg.publisher !== 'local' || pkg.name !== 'codeflare') { throw new Error('Self-update source must be the local.codeflare repository.'); }
      if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version)) { throw new Error('Self-update source must have a valid semantic version.'); }
      const top = (await this.command('git', ['rev-parse', '--show-toplevel'], sourceRoot)).toString().trim();
      if (await fs.realpath(top) !== sourceRoot) { throw new Error('The self-update source must be the repository root.'); }
      const baselineCommit = (await this.command('git', ['rev-parse', 'HEAD'], sourceRoot)).toString().trim();
      if (!/^[0-9a-f]{40,64}$/.test(baselineCommit)) { throw new Error('Cannot identify the baseline Git commit.'); }
      const id = `${Date.now()}-${randomBytes(6).toString('hex')}`;
      const directory = path.resolve(this.options.storagePath, id);
      const snapshotPath = path.join(directory, 'candidate');
      await fs.mkdir(snapshotPath, { recursive: true });
      this.progress('preparing', 'Copying the source into an isolated candidate directory.');
      const output = await this.command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], sourceRoot);
      const files = [...new Set(output.toString().split('\0').filter(Boolean))].filter(file =>
        !/^(?:\.git|\.codeflare|\.codex|node_modules|dist)(?:[\\/]|$)/.test(file) && !/\.vsix$/i.test(file));
      for (const file of files) {
        const source = path.resolve(sourceRoot, file);
        const target = path.resolve(snapshotPath, file);
        if (!inside(sourceRoot, source) || !inside(snapshotPath, target)) { throw new Error('Source path escaped the repository.'); }
        let stat;
        try { stat = await fs.lstat(source); } catch (error: any) { if (error.code === 'ENOENT') { continue; } throw error; }
        if (stat.isSymbolicLink() || !inside(sourceRoot, await fs.realpath(source))) { throw new Error(`Self-update does not copy symbolic links: ${file}`); }
        if (!stat.isFile()) { throw new Error(`Unsupported source entry: ${file}`); }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(source, target);
      }

      // Restore committed assertions/config so a candidate cannot simply remove
      // failing baseline tests. New candidate tests remain and run as well.
      const baselineFiles = (await this.command('git', ['ls-tree', '-r', '--name-only', '-z', baselineCommit, '--', 'test', 'tsconfig.json', 'vitest.config.mts'], sourceRoot)).toString().split('\0').filter(Boolean);
      if (!baselineFiles.some(file => /\.test\.[cm]?[jt]sx?$/.test(file)) || !baselineFiles.includes('vitest.config.mts') || !baselineFiles.includes('tsconfig.json')) {
        throw new Error('The committed baseline must contain tests, vitest.config.mts and tsconfig.json.');
      }
      for (const file of baselineFiles) {
        const target = path.resolve(snapshotPath, file);
        if (!inside(snapshotPath, target)) { throw new Error('Baseline path escaped the snapshot.'); }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, await this.command('git', ['show', `${baselineCommit}:${file}`], sourceRoot));
      }
      const snapshotFiles: string[] = [];
      for (const file of new Set([...files, ...baselineFiles])) {
        if (await exists(path.join(snapshotPath, file))) { snapshotFiles.push(file); }
      }
      const sourceSha256 = await sourceDigest(snapshotPath, snapshotFiles);

      // Guardrail backstop (the third layer; the turn and command gates are the
      // first two). The candidate's safety-boundary files must equal the trusted
      // anchor: the source commit of the last update that reached startup health
      // — a human activated that — or, absent one, the committed baseline. An
      // uncommitted edit differs from HEAD; an edit the agent managed to COMMIT
      // differs from the anchor. Either way the operator decides, never the model.
      // Runs before dependencies are installed so a refusal is cheap.
      const anchorCommit = await this.trustedAnchorCommit(sourceRoot);
      const guardrailChanges = await this.changedGuardrails(snapshotPath, sourceRoot, baselineCommit, anchorCommit);
      const anchorLabel = anchorCommit ? `last healthy update (${anchorCommit.slice(0, 8)})` : `committed baseline (${baselineCommit.slice(0, 8)})`;
      let guardrailCheck: string;
      if (guardrailChanges.length) {
        this.progress('guardrails', `Guardrail file(s) differ from the ${anchorLabel}; asking the operator.`);
        const approved = this.options.approveGuardrailChanges ? await this.options.approveGuardrailChanges(guardrailChanges) : false;
        if (!approved) {
          throw new Error(`Self-update refused: guardrail file(s) changed since the ${anchorLabel} and were not approved by the operator: ` +
            `${guardrailChanges.join(', ')}. Policy, evidence, isolation and self-update code only change through a reviewed commit ` +
            `plus explicit approval. The candidate snapshot is preserved.`);
        }
        guardrailCheck = `Guardrail changes approved by the operator: ${guardrailChanges.join(', ')}`;
      } else {
        guardrailCheck = `Guardrail files unchanged since the ${anchorLabel}`;
      }

      const npm = await npmCli();
      if (!await exists(path.join(snapshotPath, 'package-lock.json'))) { throw new Error('A committed package-lock.json is required for reproducible self-update dependencies.'); }
      this.progress('dependencies', 'Installing locked candidate dependencies with lifecycle scripts disabled.');
      const nodeEnv = { ELECTRON_RUN_AS_NODE: '1' };
      await this.command(process.execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], snapshotPath, 600000, nodeEnv);
      const vscePackage = path.join(snapshotPath, 'node_modules', '@vscode', 'vsce', 'package.json');
      if (!await exists(vscePackage)) { throw new Error('Add @vscode/vsce to the source devDependencies and update package-lock.json before preparing a self-update. No packaging tool was downloaded automatically.'); }
      const vsceBin = (await json(vscePackage)).bin;
      const vsce = path.resolve(path.dirname(vscePackage), typeof vsceBin === 'string' ? vsceBin : vsceBin.vsce);
      if (!inside(path.dirname(vscePackage), vsce)) { throw new Error('Invalid vsce executable path.'); }
      const checks: string[] = [guardrailCheck];
      this.progress('checking', 'Type-checking and running the committed baseline plus candidate tests.');
      await this.command(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], snapshotPath, 120000, nodeEnv);
      checks.push('TypeScript type check');
      await this.command(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.mts'], snapshotPath, 600000, nodeEnv);
      checks.push('Committed baseline tests and candidate tests');
      this.progress('building', 'Building and packaging the validated candidate without installing it.');
      await this.command(process.execPath, ['esbuild.js'], snapshotPath, 120000, nodeEnv);
      checks.push('Extension bundle build');
      const stableHelper = path.join(this.options.installedExtensionPath, 'dist', 'self-update-recovery.cjs');
      const stableSmoke = path.join(this.options.installedExtensionPath, 'dist', 'self-update-smoke.cjs');
      if (!await exists(stableHelper) || !await exists(stableSmoke)) {
        throw new Error('The running extension must contain self-update recovery and smoke runners. Manually install a CodeFlare version with self-update support first. The candidate snapshot is preserved.');
      }
      const smokePath = path.join(directory, 'self-update-smoke.cjs');
      await fs.copyFile(stableSmoke, smokePath);
      const helper = require(stableHelper) as { resolveCodeCommand: (executable: string) => { executable: string; args: string[]; env: NodeJS.ProcessEnv } };
      const cli = helper.resolveCodeCommand(this.options.executable || 'code');
      const smokeResultPath = path.join(directory, 'smoke-result.json');
      const smokeNonce = randomBytes(24).toString('hex');
      const builtBundleSha256 = sha256(await fs.readFile(path.join(snapshotPath, 'dist', 'extension.js')));
      this.progress('smoke-testing', 'Checking extension activation and required commands in an isolated VS Code host.');
      await this.command(cli.executable, [
        ...cli.args, '--wait', '--new-window', '--user-data-dir', path.join(directory, 'user-data'),
        '--extensions-dir', path.join(directory, 'extensions'), '--extensionDevelopmentPath', snapshotPath,
        '--extensionTestsPath', smokePath, '--disable-extensions', '--skip-welcome', '--skip-release-notes',
      ], snapshotPath, 120000, { ...cli.env, CODEFLARE_SELF_UPDATE_SMOKE_RESULT: smokeResultPath, CODEFLARE_SELF_UPDATE_SMOKE_NONCE: smokeNonce });
      if (!await exists(smokeResultPath)) { throw new Error('The isolated Extension Host did not report successful activation. Check the candidate host logs.'); }
      const smokeResult = await json(smokeResultPath);
      if (smokeResult.nonce !== smokeNonce || smokeResult.bundleSha256 !== builtBundleSha256 || await fs.realpath(smokeResult.extensionPath) !== await fs.realpath(snapshotPath)) {
        throw new Error('Extension Host smoke evidence does not match the tested candidate.');
      }
      checks.push('Isolated Extension Development Host activation and command registration');
      const candidateVsix = path.join(directory, `codeflare-${pkg.version}-${id}.vsix`);
      // --no-dependencies matches the repository's bundled dist/ distribution.
      // Remove package lifecycle hooks only in this disposable snapshot. VSCE
      // would otherwise invoke vscode:prepublish and run an unbounded npm script.
      const snapshotPkgPath = path.join(snapshotPath, 'package.json');
      const originalPackage = await fs.readFile(snapshotPkgPath);
      const packageOnly = JSON.parse(originalPackage.toString());
      delete packageOnly.scripts;
      await fs.writeFile(snapshotPkgPath, JSON.stringify(packageOnly, null, 2));
      try {
        await this.command(process.execPath, [vsce, 'package', '--no-dependencies', '--out', candidateVsix], snapshotPath, 180000, nodeEnv);
      } finally { await fs.writeFile(snapshotPkgPath, originalPackage); }
      if (await sourceDigest(snapshotPath, snapshotFiles) !== sourceSha256) { throw new Error('Candidate source or baseline tests changed during validation. Prepare it again.'); }
      const candidate = await inspectCodeFlareVsix(candidateVsix);
      if (candidate.bundleSha256 !== builtBundleSha256) { throw new Error('Packaged extension does not match the smoke-tested candidate.'); }
      checks.push('VSIX identity and bundle integrity');
      const prepared: PreparedSelfUpdate = {
        id, sourceRoot, snapshotPath, candidateVsix, candidateSha256: candidate.sha256,
        candidateBundleSha256: candidate.bundleSha256, version: candidate.version,
        sourceSha256, baselineCommit, preparedAt: new Date().toISOString(), checks, improvementProven: false,
      };
      await saveJson(path.join(directory, 'prepared.json'), prepared);
      this.progress('prepared', 'Candidate passed baseline tests and isolated Extension Host activation. These checks do not prove benchmark improvement.');
      return prepared;
    });
  }

  /**
   * The source commit of the last self-update that reached startup health, if
   * it is still a commit in this repository. Health is only recorded after a
   * human-activated candidate came back up, which is what makes it trustworthy.
   */
  private async trustedAnchorCommit(sourceRoot: string): Promise<string | undefined> {
    try {
      const active = await json(path.join(this.options.storagePath, 'active-update.json'));
      if (active?.status !== 'healthy' || !/^\d+-[a-f0-9]{12}$/.test(String(active.id))) { return undefined; }
      const prepared = await json(path.join(this.options.storagePath, active.id, 'prepared.json'));
      const commit = String(prepared?.baselineCommit ?? '');
      if (!/^[0-9a-f]{40,64}$/.test(commit)) { return undefined; }
      await this.command('git', ['cat-file', '-e', `${commit}^{commit}`], sourceRoot);
      return commit;
    } catch {
      return undefined; // No healthy update yet, or its commit is gone: fall back to the baseline.
    }
  }

  /**
   * Guardrail files whose candidate content differs from EITHER reference commit.
   * Compared with line endings normalised: on Windows the working copy is often
   * CRLF while `git show` yields LF, and that must not read as a change.
   */
  private async changedGuardrails(snapshotPath: string, sourceRoot: string, baselineCommit: string, anchorCommit?: string): Promise<string[]> {
    const normalise = (b: Buffer) => b.toString('utf8').replace(/\r\n/g, '\n');
    const refs = anchorCommit && anchorCommit !== baselineCommit ? [baselineCommit, anchorCommit] : [baselineCommit];
    const changed: string[] = [];
    for (const file of GUARDRAIL_PATHS) {
      const snap = path.join(snapshotPath, file);
      const candidate = await exists(snap) ? normalise(await fs.readFile(snap)) : undefined;
      for (const commit of refs) {
        let committed: string | undefined;
        try { committed = normalise(await this.command('git', ['show', `${commit}:${file}`], sourceRoot)); }
        catch { committed = undefined; } // Not present in that commit.
        if (candidate === undefined && committed === undefined) { continue; }
        if (candidate !== committed) { changed.push(file); break; }
      }
    }
    return changed;
  }

  async activate(prepared: PreparedSelfUpdate): Promise<void> {
    const activePath = path.join(this.options.storagePath, 'active-update.json');
    await this.withLock(async () => {
      if (!/^\d+-[a-f0-9]{12}$/.test(prepared.id)) { throw new Error('Invalid candidate identifier.'); }
      const directory = path.resolve(this.options.storagePath, prepared.id);
      const saved: PreparedSelfUpdate = await json(path.join(directory, 'prepared.json'));
      if (saved.candidateSha256 !== prepared.candidateSha256 || saved.candidateVsix !== prepared.candidateVsix || !inside(directory, path.resolve(saved.candidateVsix))) {
        throw new Error('Candidate metadata changed; prepare it again.');
      }
      const candidate = await inspectCodeFlareVsix(saved.candidateVsix);
      if (candidate.sha256 !== saved.candidateSha256 || candidate.bundleSha256 !== saved.candidateBundleSha256) { throw new Error('Candidate VSIX changed after validation; prepare it again.'); }
      if (!this.options.knownGoodVsix) { throw new Error('Set codeflare.selfUpdateKnownGoodVsix to a tested local.codeflare VSIX before activation. The prepared candidate is preserved.'); }
      const stable = await inspectCodeFlareVsix(this.options.knownGoodVsix);
      const installed = await json(path.join(this.options.installedExtensionPath, 'package.json'));
      if (installed.publisher !== 'local' || installed.name !== 'codeflare') { throw new Error('The running extension is not local.codeflare.'); }
      if (stable.bundleSha256 !== sha256(await fs.readFile(path.join(this.options.installedExtensionPath, 'dist', 'extension.js')))) {
        throw new Error('The known-good VSIX must match the currently installed extension bundle.');
      }
      if (!this.options.reload || !this.options.beforeReload) { throw new Error('Activation requires checkpoint and reload hooks.'); }
      if (await exists(activePath)) {
        const previous = await json(activePath);
        if (!['healthy', 'rolled-back', 'rollback-failed'].includes(previous.status)) { throw new Error('A previous update is still waiting for startup health.'); }
      }
      const knownGoodVsix = path.join(directory, 'known-good.vsix');
      await fs.copyFile(this.options.knownGoodVsix, knownGoodVsix);
      const helperSource = path.join(this.options.installedExtensionPath, 'dist', 'self-update-recovery.cjs');
      if (!await exists(helperSource)) { throw new Error('The running extension must contain the recovery helper. Install a CodeFlare version with self-update support manually first.'); }
      const helperPath = path.join(directory, 'self-update-recovery.cjs');
      await fs.copyFile(helperSource, helperPath);
      // Require the copy belonging to the running (known-good) installation.
      const helper = require(helperPath) as { resolveCodeCommand: (executable: string) => { executable: string; args: string[]; env: NodeJS.ProcessEnv } };
      const executable = this.options.executable || 'code';
      const cli = helper.resolveCodeCommand(executable);
      this.progress('checkpointing', 'Saving active work before activating the candidate.');
      await this.options.beforeReload();
      const nonce = randomBytes(24).toString('hex');
      const state = {
        id: saved.id, nonce, status: 'installing', candidateVsix: saved.candidateVsix,
        candidateSha256: saved.candidateSha256, candidateBundleSha256: saved.candidateBundleSha256,
        knownGoodVsix, knownGoodSha256: stable.sha256, executable,
        deadline: Date.now() + 240000, ackPath: path.join(directory, 'healthy.json'), readyPath: path.join(directory, 'guard-ready'),
      };
      await saveJson(activePath, state);
      const child = spawn(process.execPath, [helperPath, activePath], {
        detached: true, stdio: 'ignore', windowsHide: true, shell: false,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      let spawnError: Error | undefined;
      child.once('error', error => { spawnError = error; });
      child.unref();
      const readyDeadline = Date.now() + 10000;
      while (!await exists(state.readyPath) && Date.now() < readyDeadline && !spawnError) { await new Promise(resolve => setTimeout(resolve, 100)); }
      if (spawnError || !await exists(state.readyPath) || await fs.readFile(state.readyPath, 'utf8') !== nonce) {
        // No installation has happened. Cancel the guard if it starts late.
        await saveJson(activePath, { ...state, status: 'rollback-failed', detail: `Recovery guard did not start: ${spawnError?.message || 'timeout'}. No installation attempted.` });
        throw new Error('The independent recovery guard did not start. No update was installed.');
      }
      this.progress('installing', 'Installing the tested artifact; the independent rollback guard is active.');
      try {
        if (sha256(await fs.readFile(saved.candidateVsix)) !== saved.candidateSha256) { throw new Error('Candidate VSIX changed before installation.'); }
        await this.command(cli.executable, [...cli.args, '--install-extension', saved.candidateVsix, '--force'], directory, 120000, cli.env);
        await saveJson(activePath, { ...state, status: 'awaiting-health', deadline: Date.now() + 120000 });
      } catch (error) {
        await saveJson(activePath, { ...state, deadline: Date.now(), detail: String(error) });
        throw error;
      }
    });
    // Release the filesystem lock before reload can terminate this host process.
    this.progress('reloading', 'Reloading VS Code and waiting for startup health acknowledgement.');
    try { await this.options.reload!(); }
    catch (error) {
      const state = await json(activePath);
      await saveJson(activePath, { ...state, deadline: Date.now(), detail: String(error) });
      throw error;
    }
  }
}

/** Call only after the extension has finished registering its providers/commands. */
export async function acknowledgeSelfUpdate(storagePath: string, installedExtensionPath: string): Promise<boolean> {
  const file = path.join(storagePath, 'active-update.json');
  if (!await exists(file)) { return false; }
  const state = await json(file);
  if (state.status !== 'awaiting-health' || Date.now() >= state.deadline) { return false; }
  const bundleSha256 = sha256(await fs.readFile(path.join(installedExtensionPath, 'dist', 'extension.js')));
  if (bundleSha256 !== state.candidateBundleSha256) { return false; }
  const directory = path.resolve(storagePath, state.id);
  if (!inside(path.resolve(storagePath), directory) || !inside(directory, path.resolve(state.ackPath))) { throw new Error('Invalid update acknowledgement path.'); }
  await saveJson(state.ackPath, { id: state.id, nonce: state.nonce, bundleSha256, activatedAt: new Date().toISOString() });
  return true;
}
