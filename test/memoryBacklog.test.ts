import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { MemoryService } from '../src/engine/memoryService';
import { restoreMission, newMission } from '../src/engine/mission';

/**
 * MemoryService's side of holdouts and the backlog: withheld skills are
 * reported (not silently dropped), the backlog persists and dedups, and a
 * mission record carries its usage across a reload.
 */

let root: string;
let service: MemoryService;
const skill = (name: string) => ({ name, summary: `${name} procedure for uploads`, whenToUse: 'upload forms', steps: ['a'], checks: ['c'], sources: [] as string[] });

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'cf-memory-backlog-'));
  service = new MemoryService(join(root, 'project'), join(root, 'global'));
});
afterEach(async () => {
  const target = resolve(root);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.split(sep).at(-1)?.startsWith('cf-memory-backlog-')) { throw new Error('Unsafe test cleanup target'); }
  await fs.rm(target, { recursive: true, force: true });
});

async function validated(name: string): Promise<void> {
  await service.saveSkill(skill(name));
  await service.validateSkill(name, `mission-${name}`, [{ id: `e-${name}`, type: 'TEST', source: 'gate:auto-test', ts: Date.now(), phase: 'post-edit', result: 'pass', description: 'upload test passed' }], 'project', 1);
}

describe('contextDetailed', () => {
  it('shows eligible skills by default and reports them', async () => {
    await validated('Upload validation');
    const ctx = await service.contextDetailed('validate the upload form');
    expect(ctx.shown).toEqual([{ name: 'Upload validation', scope: 'project', version: 1 }]);
    expect(ctx.withheld).toEqual([]);
    expect(ctx.text).toContain('Upload validation');
  });

  it('withholds a skill on request, leaves the rest, and reports exactly what was withheld', async () => {
    await validated('Upload validation');
    await validated('Upload retry');
    const ctx = await service.contextDetailed('validate the upload form', name => name === 'Upload retry');
    expect(ctx.withheld).toEqual([{ name: 'Upload retry', scope: 'project', version: 1 }]);
    expect(ctx.shown.map(s => s.name)).toEqual(['Upload validation']);
    expect(ctx.text).toContain('Upload validation');
    expect(ctx.text).not.toContain('Upload retry');
    // context() is the plain view of the same thing.
    expect(await service.context('validate the upload form')).toContain('Upload retry');
  });
});

describe('backlog persistence', () => {
  it('starts empty, derives from evidence once, and survives a reopen', async () => {
    expect((await service.readBacklog()).items).toEqual([]);
    const evidence = { recurringFailures: [{ pattern: 'mock server timeouts', episodeIds: ['e1', 'e2'] }], contradictions: [], episodes: [] };
    const added = await service.deriveBacklog(evidence);
    expect(added).toHaveLength(1);
    expect(await service.deriveBacklog(evidence)).toEqual([]); // same evidence, no duplicate
    const reopened = new MemoryService(join(root, 'project'), join(root, 'global'));
    const state = await reopened.readBacklog();
    expect(state.items.map(i => [i.title.slice(0, 30), i.status])).toEqual([['Investigate recurring failure:', 'open']]);
  });

  it('updateBacklog mutates inside the store and normalises a running item on reopen', async () => {
    await service.deriveBacklog({ recurringFailures: [{ pattern: 'x', episodeIds: ['e1', 'e2'] }], contradictions: [], episodes: [] });
    await service.updateBacklog(s => { s.items[0].status = 'running'; });
    expect((await service.readBacklog()).items[0].status).toBe('open'); // coerce: nothing is running after a read
  });

  it('is unavailable without project storage', async () => {
    const globalOnly = new MemoryService(undefined, join(root, 'global2'));
    expect(await globalOnly.readBacklog()).toEqual({ schemaVersion: 1, items: [] });
    expect(await globalOnly.deriveBacklog({ recurringFailures: [{ pattern: 'x', episodeIds: ['a', 'b'] }], contradictions: [], episodes: [] })).toEqual([]);
    await expect(globalOnly.updateBacklog(s => s)).rejects.toThrow(/requires project storage/);
  });
});

describe('mission usage persistence', () => {
  it('restores usage with a mission and resets malformed usage instead of dropping the mission', () => {
    const record = { ...newMission('t', { autoTest: false, autonomous: true }, 100), status: 'paused' as const,
      usage: { turns: 3, toolCalls: 40, promptTokens: 1000, completionTokens: 50, wallMs: 60000, stalledTurns: 1 } };
    expect(restoreMission(JSON.parse(JSON.stringify(record)))?.usage).toEqual(record.usage);
    const broken = restoreMission({ ...JSON.parse(JSON.stringify(record)), usage: { turns: 'many' } });
    expect(broken).toBeDefined();
    expect(broken!.usage).toEqual({ turns: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, wallMs: 0, stalledTurns: 0 });
    expect(restoreMission(JSON.parse(JSON.stringify(newMission('t', { autoTest: false, autonomous: false }))))?.usage).toBeUndefined();
  });
});
