import * as vscode from 'vscode';
import { DEFAULT_FORBIDDEN_PATHS, DEFAULT_PROTECTED_PATHS } from '../engine/policy';

// Built-in safe (read-only / non-destructive / archived-delete) commands.
// Merged with the user's own list at load time — never replaced by it.
const DEFAULT_TRUSTED = [
  'mkdir', 'ls', 'dir', 'pwd', 'cat', 'type', 'head', 'tail', 'echo', 'wc', 'grep',
  'node', 'python', 'python3', 'npx tsc',
  // Godot — on PATH ('godot') or the official versioned binary run via .\ (the
  // '*' glob matches any version: Godot_v4.7.1-stable_win64.exe, future bumps, …).
  'godot', 'godot_v*',
  // Blender — headless mesh generation (--background --python). Rarely on PATH;
  // the configured install root is registered as a discovered executable, which
  // also session-trusts its basename.
  'blender',
  'npm install', 'npm i', 'npm init', 'npm run', 'npm ci', 'npm test', 'npm ls',
  'new-item', 'get-childitem', 'get-content', 'test-path', 'move', 'move-item', 'copy', 'copy-item',
  'out-null', 'out-string', 'out-host', 'out-default', 'write-output', 'write-host',
  'select-object', 'sort-object', 'measure-object', 'group-object', 'format-table', 'format-list',
  'set-location', 'push-location', 'pop-location',
  'rename-item', 'remove-item', 'rm', 'del', 'rmdir', 'erase', 'ri',
  'netstat', 'findstr', 'select-string', 'tasklist', 'whoami', 'hostname', 'ipconfig', 'get-process',
  'timeout', 'curl', 'curl.exe',
  'git status', 'git diff', 'git log', 'git branch',
  // Local dev/static servers — they serve workspace files on localhost and run
  // in the persistent CodeFlare terminal (SERVER_RE), so they're safe to start.
  'npx serve', 'npx http-server', 'npx live-server', 'npx vite',
  'serve', 'http-server', 'live-server', 'vite',
  'npm start', 'yarn dev', 'yarn start', 'yarn serve', 'pnpm dev', 'pnpm start', 'pnpm serve',
  'uvicorn', 'flask run',
  // PowerShell read/info cmdlets and pipeline helpers.
  'get-item', 'get-location', 'get-date', 'get-command', 'get-member',
  'resolve-path', 'split-path', 'join-path', 'compare-object', 'where-object', 'foreach-object',
  'measure-command', 'start-sleep', 'sleep', 'get-filehash', 'get-nettcpconnection', 'test-netconnection',
  'convertto-json', 'convertfrom-json', 'convertto-csv', 'convertfrom-csv',
  // Web fetches — parity with the already-trusted curl.
  'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm', 'ping',
  // Read-only network diagnostics / recon (DNS lookups, cert probes).
  'nslookup', 'nltest', 'arp', 'route print', 'getmac',
  // Object construction — TcpClient/SslStream/WebClient/Stopwatch probes. Just
  // builds objects; the acting methods (.Connect/.Close/…) stay separately gated.
  'new-object',
  // File writes — equivalent to the already-trusted `echo > file` redirect.
  'set-content', 'add-content', 'out-file', 'tee-object',
  // Archives (zips of build output / assets).
  'compress-archive', 'expand-archive',
  // Screenshot verification of built web apps (playwright CLI; install covers
  // the one-time browser download).
  'npx playwright', 'npx -y playwright', 'playwright',
  // Freeing a port by stopping a stray dev server (netstat → kill PID).
  'stop-process', 'taskkill',
  // cmd.exe classics the model falls back to.
  'tree', 'more', 'sort', 'find', 'fc', 'where', 'ver', 'systeminfo', 'xcopy',
  // Python tooling ('python -m …' is already covered by the python prefix).
  'pip install', 'pip3 install', 'pip list', 'pip show', 'py', 'pytest',
  // JS/TS tooling — linters, formatters, test runners, bundlers.
  'tsc', 'eslint', 'prettier', 'jest', 'mocha', 'vitest',
  'npx eslint', 'npx prettier', 'npx jest', 'npx vitest', 'npx mocha',
  'npx tsx', 'npx ts-node', 'npx nodemon', 'npx tailwindcss', 'npx esbuild',
  'npm outdated', 'npm audit', 'npm view', 'npm root', 'npm config get',
  'yarn install', 'yarn add', 'yarn test', 'pnpm install', 'pnpm add', 'pnpm test',
  // Git — local and non-destructive only (reset/checkout/clean stay gated).
  'git init', 'git add', 'git commit', 'git show', 'git fetch', 'git remote',
  'git stash list', 'git ls-files', 'git rev-parse', 'git describe', 'git blame',
  'git shortlog', 'git config --get', 'git config --list',
  'git grep', 'git tag', 'git worktree list', 'git stash show', 'git cherry',
  // More read-only PowerShell info cmdlets.
  'get-help', 'get-alias', 'get-variable', 'get-module', 'get-psdrive',
  'get-itemproperty', 'get-host', 'get-executionpolicy', 'get-history',
  'get-culture', 'get-unique', 'select-xml', 'clear-host', 'cls',
  // npm inspection.
  'npm why', 'npm pkg get',
  // Bulk copy — same trust level as the already-trusted xcopy/copy.
  'robocopy',
  // Running a local PowerShell test/probe script with the policy bypassed. NOTE:
  // this trusts executing ANY .ps1 by path — broad, but it matches how the HTTP
  // probing scripts here are launched. Scope it tighter per project via
  // codeflare.trustedCommands if that is too wide for a given workspace.
  'powershell -executionpolicy bypass -file', 'pwsh -executionpolicy bypass -file',
];

export type Provider = 'local' | 'openai' | 'anthropic';

// Model name discovered from the server's /v1/models (local provider only).
// Set by serverInfo.detectModel; consulted by getConfig when the user left the
// model setting blank, so a local server's model name never has to be typed.
let detectedModel = '';
export function setDetectedModel(model: string): void { detectedModel = (model || '').trim(); }
export function getDetectedModel(): string { return detectedModel; }

/**
 * The user's model setting, with the "auto" cases normalized to ''. For a local
 * server a stored value equal to the built-in default is treated as blank so
 * server discovery can supply the real name — older builds pre-filled and saved
 * that default string, which would otherwise permanently shadow discovery. The
 * webview uses this to decide whether to show the field as auto.
 */
export function explicitModelSetting(provider: Provider, rawModel: string): string {
  const raw = (rawModel || '').trim();
  if (provider === 'local' && raw === PROVIDER_DEFAULTS.local.model) { return ''; }
  return raw;
}

/** Resolve the model actually sent to the server (explicit → discovered → default). */
export function resolveModel(provider: Provider, rawModel: string, providerDefault: string): string {
  return explicitModelSetting(provider, rawModel) ||
    (provider === 'local' ? detectedModel : '') ||
    providerDefault;
}

// Per-provider fallbacks used when the endpoint/model settings are left blank.
// Keeping the settings blank-by-default lets a single stored value resolve to
// the right canonical URL/model for whichever provider is active.
export const PROVIDER_DEFAULTS: Record<Provider, { endpoint: string; model: string }> = {
  local: { endpoint: 'http://localhost:8001', model: 'QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ' },
  openai: { endpoint: 'https://api.openai.com', model: 'gpt-4o' },
  anthropic: { endpoint: 'https://api.anthropic.com', model: 'claude-opus-4-8' },
};

export interface CodeFlareConfig {
  provider: Provider;
  endpoint: string;
  model: string;
  autoDetectModel: boolean;
  maxTokens: number;
  temperature: number;
  contextLines: number;
  maxContextFiles: number;
  maxContextChars: number;
  agentMode: boolean;
  agentMaxSteps: number;
  maxParallelAgents: number;
  autonomousMode: boolean;
  autoTest: boolean;
  memoryEmbeddingModel: string;
  /** Independent judge: '' = the worker reviews itself (previous behaviour). */
  judgeProvider: Provider | '';
  judgeEndpoint: string;
  judgeModel: string;
  /** When memory reflection runs: only on request, or after each completed mission. */
  memoryReflection: 'manual' | 'after-mission';
  /** Per-field overrides on the autonomous mission budget (0 = unlimited). */
  missionBudget: Record<string, unknown>;
  /** Fraction of autonomous missions in which an eligible skill is deliberately withheld (control trial). */
  skillHoldoutRate: number;
  /** Backlog items one Night Shift run may work through. */
  nightShiftMaxItems: number;
  selfImprovement: 'off' | 'suggest' | 'automatic';
  selfUpdateKnownGoodVsix: string;
  selfUpdateCli: string;
  agentEdit: boolean;
  confirmEdits: boolean;
  editSearchMaxLines: number;
  overwriteMaxLines: number;
  agentProbes: boolean;
  probeAutoStrip: boolean;
  agentDebug: boolean;
  pentestMode: boolean;
  agentRunCommands: boolean;
  confirmCommands: boolean;
  trustedCommands: string[];
  artifactRoots: string[];
  blenderPath: string;
  commandTimeout: number;
  diagnosticsLoop: boolean;
  diagnosticsMaxRounds: number;
  verifyGate: boolean;
  verifyCommand: string;
  verifyTimeout: number;
  diffReview: boolean;
  clarifyAmbiguity: boolean;
  visualVerify: boolean;
  repoMap: boolean;
  metrics: boolean;
  imageQC: boolean;
  meshQC: boolean;
  planApproval: boolean;
  contextCompaction: boolean;
  contextAutoCompact: boolean;
  contextCompactThreshold: number;
  contextKeepRecent: number;
  webAccess: boolean;
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  streamIdleTimeout: number;
  serverMaxLifetime: number;
  // Deterministic policy (engine/policy.ts): autonomy profile, path rules, and
  // optional per-field change-budget overrides (0 = unlimited).
  autonomyProfile: 'interactive' | 'conservative-autonomous' | 'autonomous';
  allowedPaths: string[];
  protectedPaths: string[];
  forbiddenPaths: string[];
  changeBudget: Partial<{
    maxChangedFiles: number; maxNewFiles: number; maxAddedLines: number;
    maxDeletedLines: number; maxToolCalls: number; maxWallTimeMs: number;
  }>;
}

function normalizeProvider(value: string | undefined): Provider {
  return value === 'openai' || value === 'anthropic' ? value : 'local';
}

export function getConfig(): CodeFlareConfig {
  const cfg = vscode.workspace.getConfiguration('codeflare');
  const provider = normalizeProvider(cfg.get<string>('provider', 'local'));
  const defaults = PROVIDER_DEFAULTS[provider];
  return {
    provider,
    // Blank endpoint/model resolve to the active provider's canonical default.
    endpoint: (cfg.get<string>('endpoint', '') || '').trim() || defaults.endpoint,
    // Model resolution: an explicit setting wins; otherwise, for a local server,
    // use the model discovered from /v1/models; otherwise the provider default.
    // detectedModel is only applied to the local provider (OpenAI and Anthropic
    // list many models, so their default stands). NOTE: a stored value equal to
    // the local built-in default is treated as "auto" — older builds pre-filled
    // and saved that string, which would otherwise permanently shadow discovery.
    model: resolveModel(provider, (cfg.get<string>('model', '') || '').trim(), defaults.model),
    autoDetectModel: cfg.get<boolean>('autoDetectModel', true),
    maxTokens: cfg.get<number>('maxTokens', 0),
    temperature: cfg.get<number>('temperature', 0.7),
    contextLines: cfg.get<number>('contextLines', 50),
    maxContextFiles: cfg.get<number>('maxContextFiles', 5),
    maxContextChars: cfg.get<number>('maxContextChars', 32000),
    agentMode: cfg.get<boolean>('agentMode', true),
    agentMaxSteps: cfg.get<number>('agentMaxSteps', 25),
    maxParallelAgents: (() => {
      const value = cfg.get<number>('maxParallelAgents', 32);
      return Number.isFinite(value) ? Math.max(1, Math.min(32, Math.floor(value))) : 32;
    })(),
    autonomousMode: cfg.get<boolean>('autonomousMode', false),
    autoTest: cfg.get<boolean>('autoTest', false),
    memoryEmbeddingModel: cfg.get<string>('memoryEmbeddingModel', '').trim(),
    judgeProvider: (() => {
      const v = (cfg.get<string>('judgeProvider', '') || '').trim();
      return v === 'local' || v === 'openai' || v === 'anthropic' ? v : '';
    })(),
    judgeEndpoint: (cfg.get<string>('judgeEndpoint', '') || '').trim(),
    judgeModel: (cfg.get<string>('judgeModel', '') || '').trim(),
    memoryReflection: cfg.get<string>('memoryReflection', 'manual') === 'after-mission' ? 'after-mission' : 'manual',
    missionBudget: cfg.get<Record<string, unknown>>('missionBudget', {}) || {},
    skillHoldoutRate: (() => {
      const v = Number(cfg.get<number>('skillHoldoutRate', 0.1));
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    })(),
    nightShiftMaxItems: (() => {
      const v = Number(cfg.get<number>('nightShiftMaxItems', 1));
      return Number.isInteger(v) && v >= 1 && v <= 10 ? v : 1;
    })(),
    selfImprovement: (() => {
      const value = cfg.get<string>('selfImprovement', 'suggest');
      return value === 'off' || value === 'automatic' ? value : 'suggest';
    })(),
    selfUpdateKnownGoodVsix: cfg.get<string>('selfUpdateKnownGoodVsix', ''),
    selfUpdateCli: cfg.get<string>('selfUpdateCli', 'code'),
    agentEdit: cfg.get<boolean>('agentEdit', true),
    confirmEdits: cfg.get<boolean>('confirmEdits', false),
    editSearchMaxLines: cfg.get<number>('editSearchMaxLines', 60),
    overwriteMaxLines: cfg.get<number>('overwriteMaxLines', 80),
    agentProbes: cfg.get<boolean>('agentProbes', true),
    probeAutoStrip: cfg.get<boolean>('probeAutoStrip', true),
    agentDebug: cfg.get<boolean>('agentDebug', false),
    // Off by default: the offensive-security stance is injected into EVERY turn
    // when on, which pollutes ordinary coding reasoning and wastes tokens. Users
    // running authorized engagements enable it explicitly (codeflare.pentestMode).
    pentestMode: cfg.get<boolean>('pentestMode', false),
    agentRunCommands: cfg.get<boolean>('agentRunCommands', true),
    confirmCommands: cfg.get<boolean>('confirmCommands', true),
    // Built-in safe commands are ALWAYS trusted; the user's saved list adds to
    // them (it used to replace them, which silently dropped every default we
    // shipped after the user first saved their own list).
    trustedCommands: [...new Set([
      ...DEFAULT_TRUSTED,
      ...cfg.get<string[]>('trustedCommands', []),
    ])],
    artifactRoots: cfg.get<string[]>('artifactRoots', []),
    blenderPath: (cfg.get<string>('blenderPath', '') || '').trim(),
    commandTimeout: cfg.get<number>('commandTimeout', 60000),
    diagnosticsLoop: cfg.get<boolean>('diagnosticsLoop', true),
    diagnosticsMaxRounds: cfg.get<number>('diagnosticsMaxRounds', 2),
    verifyGate: cfg.get<boolean>('verifyGate', true),
    verifyCommand: (cfg.get<string>('verifyCommand', '') || '').trim(),
    verifyTimeout: cfg.get<number>('verifyTimeout', 180000),
    diffReview: cfg.get<boolean>('diffReview', true),
    clarifyAmbiguity: cfg.get<boolean>('clarifyAmbiguity', true),
    visualVerify: cfg.get<boolean>('visualVerify', true),
    repoMap: cfg.get<boolean>('repoMap', true),
    metrics: cfg.get<boolean>('metrics', true),
    imageQC: cfg.get<boolean>('imageQC', true),
    meshQC: cfg.get<boolean>('meshQC', true),
    planApproval: cfg.get<boolean>('planApproval', true),
    contextCompaction: cfg.get<boolean>('contextCompaction', true),
    contextAutoCompact: cfg.get<boolean>('contextAutoCompact', true),
    contextCompactThreshold: cfg.get<number>('contextCompactThreshold', 100000),
    contextKeepRecent: cfg.get<number>('contextKeepRecent', 20),
    webAccess: cfg.get<boolean>('webAccess', true),
    mcpServers: cfg.get('mcpServers', {}),
    streamIdleTimeout: cfg.get<number>('streamIdleTimeout', 300000),
    serverMaxLifetime: cfg.get<number>('serverMaxLifetime', 30),
    autonomyProfile: (() => {
      const v = cfg.get<string>('autonomyProfile', 'interactive');
      return v === 'conservative-autonomous' || v === 'autonomous' ? v : 'interactive';
    })(),
    allowedPaths: cfg.get<string[]>('allowedPaths', []),
    // User path rules ADD to the shipped defaults (same principle as
    // trustedCommands: saving a custom list must not drop the built-ins).
    protectedPaths: [...new Set([
      ...DEFAULT_PROTECTED_PATHS,
      ...cfg.get<string[]>('protectedPaths', []),
    ])],
    forbiddenPaths: [...new Set([
      ...DEFAULT_FORBIDDEN_PATHS,
      ...cfg.get<string[]>('forbiddenPaths', []),
    ])],
    changeBudget: cfg.get('changeBudget', {}),
  };
}
