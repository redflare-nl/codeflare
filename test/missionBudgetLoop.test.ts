import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTool: vi.fn(),
  gateToolCall: vi.fn(),
  clients: [] as object[],
  config: { agentEdit: true, agentRunCommands: true, agentMode: true, agentMaxSteps: 4, metrics: false, diagnosticsMaxRounds: 1, maxParallelAgents: 4 },
}));

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined }, Uri: { file: (fsPath: string) => ({ fsPath }) } }));
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

import { ChatViewProvider } from '../src/chat/chatViewProvider';
import { newMission } from '../src/engine/mission';

// The real agent loop (_streamResponse) with a scripted model: does the mission
// budget reach the MODEL, and does a spent budget end the turn cleanly?
function provider() {
  const subject = new ChatViewProvider({ fsPath: 'C:/codeflare-extension' } as any) as any;
  subject._mission = newMission('Reject empty uploads and accept valid uploads', { autoTest: false, autonomous: true });
  subject._postMessage = vi.fn();
  subject._publishMission = vi.fn();
  for (const seam of ['_maybeCompactContext', '_stripTurnProbes']) { subject[seam] = vi.fn().mockResolvedValue(undefined); }
  subject._showGeneratedImages = vi.fn().mockResolvedValue([]);
  for (const seam of ['_runImageQc', '_runMeshQc', '_runMetricsGate']) { subject[seam] = vi.fn().mockResolvedValue(false); }
  subject._runVerifyGate = vi.fn().mockResolvedValue(true);
  subject._runDiagnosticsRound = vi.fn().mockResolvedValue(true);
  subject._runDiffReview = vi.fn().mockResolvedValue(true);
  subject._handleUpdateTodos = vi.fn(() => 'Todos updated');
  subject._turnMetrics = { startedAt: Date.now(), promptTokens: 0, completionTokens: 0, toolCalls: 0, modelCalls: 0,
    peakCallPromptTokens: 0, steps: 0, toolCallsByName: {}, rounds: 0, editAttempts: 0, editFailures: 0,
    interventions: { approval: 0, clarification: 0, correction: 0 } };
  return subject;
}

/** A model that always asks for one more tool call, spending 210 tokens per call. */
function scriptedModel(subject: any) {
  const seen: string[] = [];
  let call = 0;
  subject._client.streamChat = vi.fn().mockImplementation(async (messages: any[]) => {
    seen.push(messages.map(m => (typeof m.content === 'string' ? m.content : '')).join(' '));
    call++;
    return {
      content: call === 1 ? '' : 'Final report: the upload check works; the retry UI is unfinished.',
      toolCalls: [{ id: `c${call}`, type: 'function', function: { name: 'update_todos', arguments: '{"todos":[]}' } }],
      reasoning: '', finishReason: 'tool_calls',
      stats: { promptTokens: 200, completionTokens: 10, genSeconds: 1 },
    };
  });
  return seen;
}

beforeEach(() => {
  mocks.gateToolCall.mockReset().mockReturnValue({ allowed: true });
  delete (mocks.config as any).missionBudget;
});

describe('mission budget steering inside the agent loop', () => {
  it('warns at wrap-up, gives a final notice when spent, and runs no tool call after it', async () => {
    const subject = provider();
    (mocks.config as any).missionBudget = { maxTokens: 1000, maxTurns: 0, maxToolCalls: 0, maxWallMs: 0, maxStalledTurns: 0 };
    subject._mission.usage = { turns: 1, toolCalls: 3, promptTokens: 850, completionTokens: 0, wallMs: 0, stalledTurns: 0 };
    const seen = scriptedModel(subject);
    await (ChatViewProvider.prototype as any)._streamResponse.call(subject, 'system', 'Add upload support');

    // 850/1000 before the first call → one wrap-up notice.
    expect(seen[0]).toMatch(/CONTROLLER NOTE[\s\S]*85% used[\s\S]*start no new features/);
    // The first call spent 210 more → spent → a final notice before the second call.
    expect(seen[1]).toMatch(/make no more tool calls/);
    // The second reply still asked for a tool: not run, and the turn ends there.
    expect(subject._client.streamChat).toHaveBeenCalledTimes(2);
    expect(subject._handleUpdateTodos).toHaveBeenCalledTimes(1);
  });

  it('stays silent for an interactive turn (no mission budget applies)', async () => {
    const subject = provider();
    subject._mission.autonomous = false;
    (mocks.config as any).missionBudget = { maxTokens: 1000, maxTurns: 0, maxToolCalls: 0, maxWallMs: 0, maxStalledTurns: 0 };
    subject._mission.usage = { turns: 1, toolCalls: 3, promptTokens: 990, completionTokens: 0, wallMs: 0, stalledTurns: 0 };
    const seen = scriptedModel(subject);
    await (ChatViewProvider.prototype as any)._streamResponse.call(subject, 'system', 'Add upload support');
    expect(seen.some(s => /CONTROLLER NOTE/.test(s))).toBe(false);
    expect(subject._client.streamChat.mock.calls.length).toBeGreaterThan(2);
  });
});

describe('token ceiling with a local model', () => {
  const tight = { maxTokens: 1000, maxTurns: 0, maxToolCalls: 0, maxWallMs: 0, maxStalledTurns: 0 };
  afterEach(() => { Object.assign(mocks.config, { provider: undefined, missionBudgetLocalUnlimitedTokens: undefined }); });

  it('is not applied locally by default, but the configured value is kept for the dialog', () => {
    const subject = provider();
    Object.assign(mocks.config, { provider: 'local', missionBudgetLocalUnlimitedTokens: true, missionBudget: tight });
    expect(subject._missionBudget().maxTokens).toBe(0);
    expect(subject._configuredMissionBudget().maxTokens).toBe(1000);
  });

  it('still applies to a hosted model, and locally when the user turns the toggle off', () => {
    const subject = provider();
    Object.assign(mocks.config, { provider: 'anthropic', missionBudgetLocalUnlimitedTokens: true, missionBudget: tight });
    expect(subject._missionBudget().maxTokens).toBe(1000);
    Object.assign(mocks.config, { provider: 'local', missionBudgetLocalUnlimitedTokens: false });
    expect(subject._missionBudget().maxTokens).toBe(1000);
  });

  it('lets a local mission past the token figure run on without a budget note', async () => {
    const subject = provider();
    Object.assign(mocks.config, { provider: 'local', missionBudgetLocalUnlimitedTokens: true, missionBudget: tight });
    subject._mission.usage = { turns: 1, toolCalls: 3, promptTokens: 5000, completionTokens: 0, wallMs: 0, stalledTurns: 0 };
    const seen = scriptedModel(subject);
    await (ChatViewProvider.prototype as any)._streamResponse.call(subject, 'system', 'Add upload support');
    expect(seen.some(s => /CONTROLLER NOTE/.test(s))).toBe(false);
    expect(subject._client.streamChat.mock.calls.length).toBeGreaterThan(2);
  });
});
