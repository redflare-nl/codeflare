import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTool: vi.fn(),
  gateToolCall: vi.fn(),
  clients: [] as object[],
  config: { agentEdit: true, agentRunCommands: true, agentMode: true, agentMaxSteps: 4, metrics: false, diagnosticsMaxRounds: 1, maxParallelAgents: 4 },
}));

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined }, Uri: { file: (fsPath: string) => ({ fsPath }) } }));
vi.mock('../src/llm/client', () => ({ VLLMClient: class { abort = vi.fn(); constructor() { mocks.clients.push(this); } } }));
vi.mock('../src/llm/tools', () => ({ executeTool: mocks.executeTool, getToolDefinitions: () => [], describeToolCall: (name: string) => name }));
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
vi.mock('../src/mcp/client', () => ({}));
vi.mock('../src/utils/projectMemory', () => ({}));
vi.mock('../src/utils/executables', () => ({}));
vi.mock('../src/utils/metrics', () => ({}));
vi.mock('../src/utils/pdf', () => ({}));
vi.mock('../src/utils/config', () => ({ getConfig: () => mocks.config }));
vi.mock('../src/utils/secrets', () => ({}));
vi.mock('../src/utils/serverInfo', () => ({}));
vi.mock('../src/utils/logger', () => ({ log: vi.fn() }));
vi.mock('../src/engine/runlog', () => ({}));
vi.mock('../src/engine/policyGate', () => ({ gateToolCall: mocks.gateToolCall }));
vi.mock('../src/engine/gitIsolation', () => ({}));

import { ChatViewProvider } from '../src/chat/chatViewProvider';
import { newMission } from '../src/engine/mission';

const successfulAuthor = (overrides: Record<string, unknown> = {}) => ({
  task: 'Write upload tests', status: 'success', summary: 'Added upload validation tests',
  changedFiles: ['test/upload.test.ts'], tests: 'Coordinator must execute',
  testCommand: 'npm test -- --run', openIssues: [], ...overrides,
});

function provider() {
  // Private seams replace external I/O; the real controller and state transitions run.
  const subject = new ChatViewProvider({ fsPath: 'C:/codeflare-extension' } as any) as any;
  subject._mission = newMission('Reject empty uploads and accept valid uploads', { autoTest: true, autonomous: true });
  subject._mission.changedFiles = ['src/upload.ts'];
  subject._turnMutatedPaths = new Set(['src/upload.ts']);
  subject._postMessage = vi.fn();
  subject._publishMission = vi.fn();
  subject._runOneSubagent = vi.fn().mockResolvedValue(successfulAuthor());
  subject._streamResponse = vi.fn().mockResolvedValue(undefined);
  subject._runVerifyGate = vi.fn().mockResolvedValue(true);
  subject._runDiagnosticsRound = vi.fn().mockResolvedValue(true);
  subject._runDiffReview = vi.fn().mockResolvedValue(true);
  return subject;
}

beforeEach(() => {
  mocks.executeTool.mockReset().mockResolvedValue('Tests 4 passed (4)\nexit code: 0');
  mocks.gateToolCall.mockReset().mockReturnValue({ allowed: true });
  mocks.clients.length = 0;
  Object.assign(mocks.config, { agentEdit: true, agentRunCommands: true, agentMode: true, diagnosticsMaxRounds: 1 });
});

describe('provider independent test stage', () => {
  it('uses a fresh test author and executes its command through the actual tool boundary', async () => {
    const subject = provider();
    subject._history.push({ role: 'assistant', content: 'Implementation is certainly correct; no tests needed' });
    await subject._runTestStage();
    expect(subject._runOneSubagent).toHaveBeenCalledTimes(1);
    const [task, client, label, testsOnly] = subject._runOneSubagent.mock.calls[0];
    expect(task).toContain(subject._mission.task);
    expect(task).toContain('src/upload.ts');
    expect(task).toContain('Only test files may be edited');
    expect(task).not.toContain('Implementation is certainly correct');
    expect(client).not.toBe(subject._client);
    expect(label).toBe('[Tests]');
    expect(testsOnly).toBe(true);
    expect(mocks.executeTool).toHaveBeenCalledWith('run_command', JSON.stringify({ command: 'npm test -- --run' }));
    expect(subject._mission.testStatus).toBe('passed');
    expect(subject._turnEvidence).toContainEqual(expect.objectContaining({
      type: 'TEST', source: 'gate:auto-test', result: 'pass', checkId: 'auto-test:npm test -- --run',
    }));
    expect(subject._testStageRunning).toBe(false);
  });

  it.each(['', 'none', 'npm run build', 'npm test -- --passWithNoTests'])('does not execute unsupported author command "%s"', async testCommand => {
    const subject = provider();
    subject._runOneSubagent.mockResolvedValue(successfulAuthor({ testCommand }));
    await subject._runTestStage();
    expect(subject._mission.testStatus).toBe('incomplete');
    expect(mocks.executeTool).not.toHaveBeenCalled();
    expect(subject._streamResponse).not.toHaveBeenCalled();
  });

  it.each([
    'No tests found\nexit code: 0',
    '0 passed (0)\nexit code: 0',
    'Tests started in a background terminal',
    'TypeScript compiled successfully\nexit code: 0',
  ])('does not treat absent executed-test evidence as success (%s)', async output => {
    const subject = provider();
    mocks.executeTool.mockResolvedValue(output);
    await subject._runTestStage();
    expect(subject._mission.testStatus).toBe('incomplete');
    expect(subject._streamResponse).not.toHaveBeenCalled();
    expect(subject._turnEvidence[0].result).toBe('inconclusive');
  });

  it('returns visibly to build for repair and then launches another independent verification', async () => {
    const subject = provider();
    mocks.executeTool.mockResolvedValueOnce('1 failed, 3 passed\nexit code: 1')
      .mockResolvedValueOnce('4 passed\nexit code: 0');
    await subject._runTestStage();
    expect(subject._mission.testStatus).toBe('passed');
    expect(subject._runOneSubagent).toHaveBeenCalledTimes(2);
    expect(subject._runOneSubagent.mock.calls[0][1]).not.toBe(subject._runOneSubagent.mock.calls[1][1]);
    expect(subject._streamResponse).toHaveBeenCalledTimes(1);
    expect(subject._streamResponse.mock.calls[0][1]).toContain('Do not weaken assertions or alter acceptance criteria');
    expect(subject._mission.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'verify', to: 'build', backward: true }),
      expect.objectContaining({ from: 'build', to: 'verify', backward: false }),
    ]));
    expect(subject._turnEvidence.map((item: any) => item.result)).toEqual(['fail', 'pass']);
  });

  it('stops after the configured repair budget is exhausted', async () => {
    const subject = provider();
    mocks.executeTool.mockResolvedValue('1 failed\nexit code: 1');
    await subject._runTestStage();
    expect(subject._runOneSubagent).toHaveBeenCalledTimes(2);
    expect(subject._streamResponse).toHaveBeenCalledTimes(1);
    expect(subject._mission.testStatus).toBe('failed');
  });

  it('does not start another test agent when the repair pauses for user input', async () => {
    const subject = provider();
    mocks.executeTool.mockResolvedValue('1 failed\nexit code: 1');
    subject._streamResponse.mockImplementation(async () => { subject._missionPaused = true; });
    await subject._runTestStage();
    expect(subject._runOneSubagent).toHaveBeenCalledTimes(1);
    expect(subject._mission.testStatus).toBe('incomplete');
    subject._finishMission();
    expect(subject._mission.status).toBe('paused');
  });

  it('does not run an author or command when already stopped', async () => {
    const subject = provider();
    subject._stopRequested = true;
    await subject._runTestStage();
    expect(subject._runOneSubagent).not.toHaveBeenCalled();
    expect(mocks.executeTool).not.toHaveBeenCalled();
    subject._finishMission();
    expect(subject._mission.status).toBe('paused');
  });

  it('suppresses execution when Stop arrives while the author is working', async () => {
    const subject = provider();
    subject._runOneSubagent.mockImplementation(async () => {
      subject._stopRequested = true;
      return successfulAuthor();
    });
    await subject._runTestStage();
    expect(mocks.executeTool).not.toHaveBeenCalled();
    expect(subject._mission.testStatus).toBe('incomplete');
    expect(subject._testStageRunning).toBe(false);
  });

  it('discards a completed command when the user clears the task while it runs', async () => {
    const subject = provider();
    subject._history.push({ role: 'user', content: 'Old conversation' });
    mocks.executeTool.mockImplementation(async () => {
      subject.clearChat();
      return '4 passed\nexit code: 0';
    });
    await subject._runTestStage();
    expect(subject._mission).toBeUndefined();
    expect(subject._history).toEqual([]);
    expect(subject._turnEvidence).toEqual([]);
    expect(subject._client.abort).toHaveBeenCalledTimes(1);
    expect(subject._runDiagnosticsRound).not.toHaveBeenCalled();
    expect(subject._runVerifyGate).not.toHaveBeenCalled();
    expect(subject._testStageRunning).toBe(false);
    expect(subject._postMessage.mock.calls.some(([message]: any[]) => message.type === 'notice' && message.level === 'success')).toBe(false);
  });

  it('honors command budget rejection after authoring', async () => {
    const subject = provider();
    mocks.gateToolCall.mockReturnValue({ allowed: false });
    await subject._runTestStage();
    expect(mocks.executeTool).not.toHaveBeenCalled();
    expect(subject._mission.testStatus).toBe('incomplete');
  });

  it.each([
    { openIssues: ['Cancellation is not covered'] },
    { status: 'partial' },
  ])('keeps green tests incomplete when authoring reports a gap (%j)', async overrides => {
    const subject = provider();
    subject._runOneSubagent.mockResolvedValue(successfulAuthor(overrides));
    await subject._runTestStage();
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    expect(subject._mission.testStatus).toBe('incomplete');
    subject._finishMission();
    expect(subject._mission.status).toBe('paused');
  });

  it('reruns diagnostics, verification and review after the test author has changed the tree', async () => {
    const subject = provider();
    subject._runOneSubagent.mockImplementation(async () => {
      subject._mission.changedFiles.push('test/upload.test.ts');
      subject._turnMutatedPaths.add('test/upload.test.ts');
      return successfulAuthor();
    });
    await subject._runTestStage();
    expect(subject._runDiagnosticsRound).toHaveBeenCalled();
    expect(subject._runVerifyGate).toHaveBeenCalled();
    expect(subject._runDiffReview).toHaveBeenCalled();
    expect([...subject._runVerifyGate.mock.calls[0][0]]).toContain('test/upload.test.ts');
  });

  it('fails closed when editing, commands or agent mode is disabled', async () => {
    for (const key of ['agentEdit', 'agentRunCommands', 'agentMode'] as const) {
      const subject = provider();
      mocks.config[key] = false;
      await subject._runTestStage();
      expect(subject._runOneSubagent).not.toHaveBeenCalled();
      expect(subject._mission.testStatus).toBe('incomplete');
      mocks.config[key] = true;
    }
  });
});

describe('provider mission completion', () => {
  it('keeps the current phase when existing todo items only advance their status', () => {
    const subject = provider();
    subject._missionPhase('build', 'Implementing upload validation');
    subject._mission.testStatus = 'passed';
    subject._todos = [
      { content: 'Implement upload', status: 'in_progress' },
      { content: 'Verify upload', status: 'pending' },
    ];
    const history = [...subject._mission.transitions];
    const update = JSON.stringify({ todos: [
      { content: 'Implement upload', status: 'completed' },
      { content: 'Verify upload', status: 'in_progress' },
    ] });
    subject._missionTool('update_todos', update);
    subject._handleUpdateTodos(update);
    expect(subject._mission.phase).toBe('build');
    expect(subject._mission.testStatus).toBe('passed');
    expect(subject._mission.transitions).toEqual(history);
    expect(subject._todos[0].status).toBe('completed');
  });

  it('returns to design when the actual plan changes and invalidates prior verification', () => {
    const subject = provider();
    subject._missionPhase('verify', 'Checking upload');
    subject._mission.testStatus = 'passed';
    subject._todos = [{ content: 'Implement upload', status: 'completed' }];
    subject._handleUpdateTodos(JSON.stringify({ todos: [
      { content: 'Implement upload', status: 'completed' },
      { content: 'Add an upload cancellation flow', status: 'pending' },
    ] }));
    expect(subject._mission.phase).toBe('design');
    expect(subject._mission.testStatus).toBe('pending');
    expect(subject._mission.transitions.at(-1)).toMatchObject({ from: 'verify', to: 'design', backward: true });
  });

  it.each([
    ['Which upload size limit should I use?', true, 'paused'],
    ['The upload limit is five megabytes.', false, 'completed'],
  ])('detects clarification with metrics disabled: %s', async (reply, paused, status) => {
    const subject = provider();
    subject._turnMetrics = undefined;
    subject._turnMutatedPaths.clear();
    subject._mission.changedFiles = [];
    subject._maybeCompactContext = vi.fn().mockResolvedValue(undefined);
    subject._showGeneratedImages = vi.fn().mockResolvedValue([]);
    subject._runImageQc = vi.fn().mockResolvedValue(false);
    subject._runMeshQc = vi.fn().mockResolvedValue(false);
    subject._runMetricsGate = vi.fn().mockResolvedValue(false);
    subject._stripTurnProbes = vi.fn().mockResolvedValue(undefined);
    subject._client.streamChat = vi.fn().mockImplementation(async (_messages, callbacks) => {
      callbacks.onToken(reply);
      return { content: reply, toolCalls: [], reasoning: '', finishReason: 'stop' };
    });
    // Invoke the real stream loop, bypassing only the helper's repair seam.
    await (ChatViewProvider.prototype as any)._streamResponse.call(subject, 'system', 'Add upload support');
    expect(subject._turnFailed).toBe(false);
    expect(subject._client.streamChat).toHaveBeenCalledTimes(1);
    expect(subject._missionPaused).toBe(paused);
    subject._finishMission();
    expect(subject._mission.status).toBe(status);
  });

  it.each([
    ['failed', 'failed'], ['incomplete', 'paused'], ['pending', 'paused'], ['running', 'paused'],
  ])('never completes with test state %s', (testStatus, expectedStatus) => {
    const subject = provider();
    subject._mission.testStatus = testStatus;
    subject._lastExperiment = { decision: 'ACCEPTED' };
    subject._finishMission();
    expect(subject._mission.status).toBe(expectedStatus);
    expect(subject._mission.phase).not.toBe('deliver');
  });

  it.each([
    ['_stopRequested', 'paused'], ['_turnFailed', 'failed'], ['_turnIncomplete', 'paused'], ['_missionPaused', 'paused'],
  ])('preserves an interrupted outcome signaled by %s', (flag, expectedStatus) => {
    const subject = provider();
    subject[flag] = true;
    subject._mission.testStatus = 'passed';
    subject._finishMission();
    expect(subject._mission.status).toBe(expectedStatus);
  });

  it.each([['REJECTED', 'failed'], ['NEEDS_REVIEW', 'paused']])('does not override an experiment decision %s', (decision, expectedStatus) => {
    const subject = provider();
    subject._mission.testStatus = 'passed';
    subject._lastExperiment = { decision };
    subject._finishMission();
    expect(subject._mission.status).toBe(expectedStatus);
  });

  it('delivers a tested and accepted mission', () => {
    const subject = provider();
    subject._mission.testStatus = 'passed';
    subject._lastExperiment = { decision: 'ACCEPTED' };
    subject._finishMission();
    expect(subject._mission.status).toBe('completed');
    expect(subject._mission.phase).toBe('deliver');
  });

  it('explicitly skips automatic tests when no files were changed', () => {
    const subject = provider();
    subject._turnMutatedPaths.clear();
    subject._mission.changedFiles = [];
    subject._finishMission();
    expect(subject._mission.testStatus).toBe('skipped');
    expect(subject._mission.status).toBe('completed');
  });
});

describe('provider reload coordination', () => {
  it('blocks incoming work synchronously while save is pending and until activation finishes', async () => {
    const subject = provider();
    let finishSave!: () => void;
    const pendingSave = new Promise<void>(resolve => { finishSave = resolve; });
    subject._state = { update: vi.fn().mockReturnValue(pendingSave) };
    subject._history = [{ role: 'user', content: 'Saved original task' }];
    const originalMission = subject._mission;
    const prepared = subject.prepareForReload();
    expect(subject._reloadPending).toBe(true);

    await subject._handleUserMessage('Start another task during saving');
    expect(subject._busy).toBe(false);
    expect(subject._streamResponse).not.toHaveBeenCalled();
    expect(subject._queue).toEqual([]);
    expect(subject._mission).toBe(originalMission);
    expect(subject._history).toEqual([{ role: 'user', content: 'Saved original task' }]);
    expect(subject._postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'notice' }));

    finishSave();
    await prepared;
    expect(subject._reloadPending).toBe(true);
    await subject._handleUserMessage('Start another task during installation');
    expect(subject._streamResponse).not.toHaveBeenCalled();
    expect(subject._queue).toEqual([]);
  });

  it('releases the input guard if saving the memento fails', async () => {
    const subject = provider();
    subject._state = { update: vi.fn().mockRejectedValue(new Error('Memento disk full')) };
    await expect(subject.prepareForReload()).rejects.toThrow('Memento disk full');
    expect(subject._reloadPending).toBe(false);
  });

  it.each(['_missionPersistenceError', '_checkpointPersistenceError'])('releases the input guard on saved-state error %s', async errorField => {
    const subject = provider();
    subject[errorField] = new Error('Write failed');
    await expect(subject.prepareForReload()).rejects.toThrow('Write failed');
    expect(subject._reloadPending).toBe(false);
  });

  it('allows input again when the updater cancels a prepared reload', async () => {
    const subject = provider();
    await subject.prepareForReload();
    expect(subject._reloadPending).toBe(true);
    subject.cancelPreparedReload();
    expect(subject._reloadPending).toBe(false);
    // Existing busy-task queuing demonstrates that input reaches the normal path.
    subject._busy = true;
    await subject._handleUserMessage('Continue after the update failed');
    expect(subject._queue).toEqual([{ text: 'Continue after the update failed', images: undefined, files: undefined }]);
  });
});

describe('provider scoped skill memory', () => {
  const sharedName = 'Verify upload boundaries';
  const skill = (scope: 'project' | 'global', version = 1) => ({
    name: sharedName, scope, version, summary: `${scope} upload procedure`, status: 'candidate',
    whenToUse: 'When validating uploads', steps: ['Exercise input boundaries'], checks: ['Run upload tests'], sources: [],
  });

  function withKnowledge(records = [skill('project'), skill('global')]) {
    const subject = provider();
    const knowledge = {
      recordLandscape: vi.fn().mockResolvedValue('Landscape saved'),
      saveSkill: vi.fn().mockResolvedValue('Candidate saved'),
      list: vi.fn().mockResolvedValue({ schemaVersion: 1, landscapes: [], skills: records }),
      getSkill: vi.fn().mockImplementation(async (name: string, scope: string) =>
        records.find(entry => entry.name === name && entry.scope === scope)),
      recordSkillOutcome: vi.fn().mockResolvedValue('Trial outcome recorded'),
      context: vi.fn().mockResolvedValue('Relevant skill data'),
      // The provider loads skills through contextDetailed (holdout-aware); route
      // it through the plain mock so the existing context() expectations — and
      // the rejection case — keep describing the same behaviour.
      contextDetailed: vi.fn().mockImplementation(async (query: string) => ({ text: await knowledge.context(query), shown: [], withheld: [] })),
    };
    subject._knowledge = knowledge;
    return { subject, knowledge, records };
  }

  it.each([
    [undefined, 'project'], ['project', 'project'], ['global', 'global'],
  ])('saves a candidate in the requested scope %s (defaulting to project)', async (requested, expected) => {
    const { subject, knowledge } = withKnowledge();
    const input = { name: sharedName, summary: 'Reusable procedure', ...(requested ? { scope: requested } : {}) };
    expect(await subject._knowledgeTool('save_skill', JSON.stringify(input))).toBe('Candidate saved');
    expect(knowledge.saveSkill).toHaveBeenCalledWith(input, expected);
  });

  it('keeps landscapes in the project store even if a global skill scope is supplied', async () => {
    const { subject, knowledge } = withKnowledge();
    const landscape = { goal: 'Project-specific upload constraints', scope: 'global' };
    await subject._knowledgeTool('record_landscape', JSON.stringify(landscape));
    expect(knowledge.recordLandscape).toHaveBeenCalledWith(subject._mission.id, landscape);
    expect(knowledge.saveSkill).not.toHaveBeenCalled();
    expect(knowledge.getSkill).not.toHaveBeenCalled();
  });

  it.each(['save_skill', 'try_skill', 'list_skills'])('rejects invalid scope before calling storage for %s', async tool => {
    const { subject, knowledge } = withKnowledge();
    const response = await subject._knowledgeTool(tool, JSON.stringify({ name: sharedName, scope: 'all-projects' }));
    expect(response).toContain('Invalid skill scope');
    expect(knowledge.saveSkill).not.toHaveBeenCalled();
    expect(knowledge.getSkill).not.toHaveBeenCalled();
    expect(knowledge.list).not.toHaveBeenCalled();
    expect(subject._skillTrials.size).toBe(0);
  });

  it('lists identically named project and global skills with their distinct scopes', async () => {
    const { subject } = withKnowledge();
    const listed = JSON.parse(await subject._knowledgeTool('list_skills', '{}'));
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: sharedName, scope: 'project' }),
      expect.objectContaining({ name: sharedName, scope: 'global' }),
    ]));
  });

  it('tries project by default and tracks the same global skill name as a separate trial', async () => {
    const { subject, knowledge } = withKnowledge([skill('project', 2), skill('global', 7)]);
    const project = await subject._knowledgeTool('try_skill', JSON.stringify({ name: sharedName }));
    const global = await subject._knowledgeTool('try_skill', JSON.stringify({ name: sharedName, scope: 'global' }));
    expect(knowledge.getSkill).toHaveBeenNthCalledWith(1, sharedName, 'project');
    expect(knowledge.getSkill).toHaveBeenNthCalledWith(2, sharedName, 'global');
    expect(project).toContain('ADVISORY SKILL DATA');
    expect(project).toContain('"scope":"project"');
    expect(global).toContain('"scope":"global"');
    expect([...subject._skillTrials.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: sharedName, scope: 'project', version: 2 }),
      expect.objectContaining({ name: sharedName, scope: 'global', version: 7 }),
    ]));
    expect(subject._skillTrials.size).toBe(2);
  });

  it('does not fall back to a global skill when the requested project skill is absent', async () => {
    const { subject, knowledge } = withKnowledge([skill('global')]);
    const response = await subject._knowledgeTool('try_skill', JSON.stringify({ name: sharedName }));
    expect(response).toContain('Skill not found in that scope');
    expect(knowledge.getSkill).toHaveBeenCalledWith(sharedName, 'project');
    expect(subject._skillTrials.size).toBe(0);
  });

  it.each(['project', 'global'] as const)('validates a completed trial only in its %s scope', async scope => {
    const { subject, knowledge } = withKnowledge([skill('project', 2), skill('global', 7)]);
    await subject._knowledgeTool('try_skill', JSON.stringify({ name: sharedName, scope }));
    subject._mission.status = 'completed';
    subject._mission.testStatus = 'passed';
    subject._lastExperiment = { decision: 'ACCEPTED' };
    const evidence = {
      id: 'upload-check', ts: Date.now(), type: 'TEST', result: 'pass', phase: 'post-edit',
      source: 'gate:auto-test', description: 'Upload boundary tests passed',
    };
    subject._turnEvidence = [evidence];
    await subject._validateSkillTrials();
    expect(knowledge.recordSkillOutcome).toHaveBeenCalledTimes(1);
    // Trailing `false`: a tried skill is a TREATED trial, never a control one.
    expect(knowledge.recordSkillOutcome).toHaveBeenCalledWith(sharedName, subject._mission.id, 'success', [evidence], scope, scope === 'project' ? 2 : 7, false);
  });

  it('does not validate a changed global version using the same-name project version', async () => {
    const { subject, knowledge, records } = withKnowledge();
    await subject._knowledgeTool('try_skill', JSON.stringify({ name: sharedName, scope: 'global' }));
    subject._mission.status = 'completed';
    subject._mission.testStatus = 'passed';
    subject._lastExperiment = { decision: 'ACCEPTED' };
    records.find(entry => entry.scope === 'global')!.version = 2;
    await subject._validateSkillTrials();
    expect(knowledge.recordSkillOutcome).not.toHaveBeenCalled();
  });

  it('does not validate a removed global trial against a surviving project skill', async () => {
    const { subject, knowledge, records } = withKnowledge();
    await subject._knowledgeTool('try_skill', JSON.stringify({ name: sharedName, scope: 'global' }));
    subject._mission.status = 'completed';
    subject._mission.testStatus = 'passed';
    subject._lastExperiment = { decision: 'ACCEPTED' };
    records.splice(records.findIndex(entry => entry.scope === 'global'), 1);
    await subject._validateSkillTrials();
    expect(knowledge.recordSkillOutcome).not.toHaveBeenCalled();
  });

  it('reports a memory read failure and continues with empty learned context', async () => {
    const { subject, knowledge } = withKnowledge();
    knowledge.context.mockRejectedValue(new Error('Corrupt skill memory'));
    await expect(subject._loadSkillContext('Validate uploads')).resolves.toBe('');
    expect(knowledge.context).toHaveBeenCalledWith('Validate uploads');
    expect(subject._postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'notice', text: expect.stringContaining('Corrupt skill memory'),
    }));
  });

  it('records a failed use only when failed mission execution supplies test evidence', async () => {
    const { subject, knowledge } = withKnowledge();
    await subject._knowledgeTool('try_skill', JSON.stringify({ name: sharedName, scope: 'global' }));
    subject._mission.status = 'failed';
    const evidence = { id: 'failed-test', ts: Date.now(), type: 'TEST', source: 'gate:auto-test',
      phase: 'post-edit', result: 'fail', description: 'Boundary test failed' };
    subject._turnEvidence = [evidence];
    await subject._validateSkillTrials();
    expect(knowledge.recordSkillOutcome).toHaveBeenCalledWith(sharedName, subject._mission.id, 'failure', [evidence], 'global', 1, false);
  });

  it.each(['paused', 'stopped', 'model-error'])('records %s as inconclusive without inventing failure evidence', async state => {
    const { subject, knowledge } = withKnowledge();
    await subject._knowledgeTool('try_skill', JSON.stringify({ name: sharedName }));
    subject._mission.status = state === 'model-error' ? 'failed' : 'paused';
    subject._stopRequested = state === 'stopped';
    subject._turnEvidence = [];
    await subject._validateSkillTrials();
    expect(knowledge.recordSkillOutcome).toHaveBeenCalledWith(sharedName, subject._mission.id, 'inconclusive', [], 'project', 1, false);
  });

  it('does not erase the first application timestamp when a skill is reread', async () => {
    const { subject } = withKnowledge();
    await subject._knowledgeTool('try_skill', JSON.stringify({ name: sharedName }));
    const first = [...subject._skillTrials.values()][0];
    first.at = 100;
    await subject._knowledgeTool('try_skill', JSON.stringify({ name: sharedName }));
    expect([...subject._skillTrials.values()][0].at).toBe(100);
  });
});
