import { describe, expect, it } from 'vitest';
import {
  buildResumePrompt, MissionRecord, newMission, restoreMission, setMissionStatus, transitionMission,
} from '../src/engine/mission';

function mission(overrides: Partial<MissionRecord> = {}): MissionRecord {
  return { ...newMission('Build an upload form', { autoTest: true, autonomous: true }, 100), ...overrides };
}

describe('mission progress', () => {
  it('starts a distinct mission with pending verification or explicitly skipped tests', () => {
    const first = mission();
    const second = mission();
    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({ phase: 'explore', status: 'running', testStatus: 'pending', startedAt: 100, updatedAt: 100 });
    expect(newMission('Explain this function', { autoTest: false, autonomous: false }, 100).testStatus).toBe('skipped');
  });

  it('records real backward transitions and invalidates the previous passing verdict', () => {
    const before = mission({ phase: 'verify', testStatus: 'passed' });
    const repaired = transitionMission(before, 'build', 'Empty-file upload fails; repair validation', 200);
    expect(repaired.phase).toBe('build');
    expect(repaired.testStatus).toBe('pending');
    expect(repaired.transitions).toEqual([{
      from: 'verify', to: 'build', reason: 'Empty-file upload fails; repair validation', at: 200, backward: true,
    }]);
    expect(before.phase).toBe('verify');
    expect(before.testStatus).toBe('passed');
    expect(before.transitions).toEqual([]);
    const checking = transitionMission(repaired, 'verify', 'Check repaired validation', 300);
    expect(checking.transitions[1].backward).toBe(false);
    expect(checking.testStatus).toBe('pending');
  });

  it('supports returning to research and keeps the latest 100 transitions', () => {
    let record = mission();
    for (let index = 0; index < 120; index++) {
      record = transitionMission(record, index % 2 === 0 ? 'build' : 'explore', `step ${index}`, 101 + index);
    }
    expect(record.transitions).toHaveLength(100);
    expect(record.transitions[0].reason).toBe('step 20');
    expect(record.transitions[99]).toMatchObject({ reason: 'step 119', to: 'explore', backward: true });
  });

  it('updates same-phase activity without adding fictional phase changes or regressing time', () => {
    const original = mission();
    const updated = transitionMission(original, 'explore', 'Inspect API documentation', 50);
    expect(updated.transitions).toEqual([]);
    expect(updated.activity).toBe('Inspect API documentation');
    expect(updated.updatedAt).toBe(100);
    expect(original.activity).toBe('Exploring the task');
  });

  it('preserves history and phase when a task pauses', () => {
    const running = transitionMission(mission(), 'build', 'Implement upload', 200);
    const paused = setMissionStatus(running, 'paused', 'Waiting for input', 300);
    expect(paused).toMatchObject({ phase: 'build', status: 'paused', activity: 'Waiting for input', updatedAt: 300 });
    expect(paused.transitions).toEqual(running.transitions);
    expect(running.status).toBe('running');
  });
});

describe('mission recovery', () => {
  it('marks old processes interrupted without losing completed work or mutating the checkpoint', () => {
    const saved = mission({
      phase: 'verify', testStatus: 'running', changedFiles: ['src/upload.ts'],
      agents: [
        { id: 'api', task: 'Build API', status: 'success', activity: 'Complete' },
        { id: 'ui', task: 'Build UI', status: 'running', activity: 'Writing upload form' },
        { id: 'tests', task: 'Write tests', status: 'queued', activity: 'Waiting for UI' },
      ],
    });
    const restored = restoreMission(saved, 200)!;
    expect(restored.status).toBe('interrupted');
    expect(restored.phase).toBe('verify');
    expect(restored.updatedAt).toBe(200);
    expect(restored.testStatus).toBe('incomplete');
    expect(restored.agents.map(agent => agent.status)).toEqual(['success', 'interrupted', 'interrupted']);
    expect(restored.changedFiles).toEqual(['src/upload.ts']);
    restored.changedFiles.push('new.ts');
    restored.agents[0].activity = 'Changed copy';
    expect(saved.changedFiles).toEqual(['src/upload.ts']);
    expect(saved.agents[0].activity).toBe('Complete');
    expect(saved.status).toBe('running');
    expect(saved.testStatus).toBe('running');
  });

  it.each(['completed', 'paused', 'failed', 'interrupted'] as const)('preserves a %s checkpoint instead of silently resuming it', status => {
    const saved = mission({ status, phase: 'deliver', testStatus: 'passed' });
    expect(restoreMission(JSON.parse(JSON.stringify(saved)), 500)).toEqual(saved);
  });

  it.each([
    null, [], {}, { schemaVersion: 2 },
    { ...mission(), schemaVersion: 2 },
    { ...mission(), status: 'accepted' },
    { ...mission(), phase: 'repair' },
    { ...mission(), autoTest: 'true' },
    { ...mission(), updatedAt: Infinity },
    { ...mission(), updatedAt: 99 },
    { ...mission(), changedFiles: ['ok', 5] },
    { ...mission(), agents: [{ id: 'a', status: 'running' }] },
    { ...mission(), transitions: [{ from: 'build', to: 'verify', reason: 'check', at: 100, backward: true }] },
  ])('rejects malformed persisted state %#', raw => {
    expect(restoreMission(raw, 200)).toBeUndefined();
  });

  it('rejects duplicate agent identifiers', () => {
    const agent = { id: 'same', task: 'API', status: 'running' as const, activity: 'Working' };
    expect(restoreMission(mission({ agents: [agent, { ...agent }] }))).toBeUndefined();
  });

  it('includes reconciliation instructions and the original task in the resume prompt', () => {
    const prompt = buildResumePrompt(mission({ changedFiles: ['src/upload.ts'], phase: 'build' }));
    expect(prompt).toContain('First reread the current workspace files');
    expect(prompt).toContain('Do not repeat external actions');
    expect(prompt).toContain('Never assume an interrupted action failed');
    expect(prompt).toContain('Build an upload form');
    expect(prompt).toContain('src/upload.ts');
    expect(prompt).toContain('existing permissions and budget');
  });
});
