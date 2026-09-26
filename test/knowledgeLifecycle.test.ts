import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { KnowledgeStore, SKILL_FAILURE_COOLDOWN_MS, SKILL_MAX_AGE_MS, SkillInput } from '../src/engine/missionKnowledge';
import { ScopedKnowledgeStore } from '../src/engine/scopedKnowledge';
import { EvidenceItem } from '../src/engine/evidence';

const input: SkillInput = { name: 'WebGL profiling', summary: 'Profile frame time alongside page performance',
  whenToUse: 'Client-heavy WebGL pages', domains: ['web', 'webgl'], steps: ['Measure frame durations'],
  checks: ['Run an animation workload and check dropped frames'], sources: ['https://example.com/profiling'] };
let directory: string;
let a: ScopedKnowledgeStore;
let b: ScopedKnowledgeStore;
let now: number;
const proof = (result: 'pass' | 'fail' = 'pass'): EvidenceItem[] => [{ id: `run-${now}`, type: 'TEST', source: 'gate:auto-test',
  ts: now, phase: 'post-edit', description: 'Browser animation workload', result }];
beforeEach(async () => {
  now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  directory = await fs.mkdtemp(join(tmpdir(), 'cf-lifecycle-'));
  a = new ScopedKnowledgeStore(join(directory, 'project-A'), join(directory, 'global'));
  b = new ScopedKnowledgeStore(join(directory, 'project-B'), join(directory, 'global'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  const target = resolve(directory);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.split(sep).at(-1)?.startsWith('cf-lifecycle-')) { throw new Error('Unsafe test cleanup'); }
  await fs.rm(target, { recursive: true, force: true });
});

describe('evidence-driven memory lifecycle', () => {
  it('treats a global skill as a hypothesis until two missions in two workspaces prove it', async () => {
    await a.saveSkill(input, 'global');
    now++;
    await a.validateSkill(input.name, 'mission-A1', proof(), 'global', 1);
    expect(await b.context('WebGL profiling')).toBe('');
    await a.validateSkill(input.name, 'mission-A2', proof(), 'global', 1);
    expect((await a.getSkill(input.name, 'global'))?.status).toBe('candidate');
    await b.validateSkill(input.name, 'mission-B1', proof(), 'global', 1);
    const global = await b.getSkill(input.name, 'global');
    expect(global).toMatchObject({ status: 'validated', successfulUses: 3, failedUses: 0, confidence: 0.8 });
    expect(global!.domains).toEqual(['web', 'webgl']);
    expect(await b.context('WebGL profiling')).toContain('"confidence":0.8');
    const restarted = new ScopedKnowledgeStore(join(directory, 'project-B'), join(directory, 'global'));
    expect((await restarted.getSkill(input.name, 'global'))?.successfulUses).toBe(3);
  });

  it('requires independent mission identities even across distinct workspaces', async () => {
    await a.saveSkill(input, 'global');
    await a.validateSkill(input.name, 'same-mission', proof(), 'global', 1);
    await b.validateSkill(input.name, 'same-mission', proof(), 'global', 1);
    expect((await b.getSkill(input.name, 'global'))?.status).toBe('candidate');
  });

  it('deduplicates conclusive results without changing counts or aging timestamps', async () => {
    await a.saveSkill(input);
    await a.validateSkill(input.name, 'mission-A', proof(), 'project', 1);
    const first = await a.getSkill(input.name);
    now += 10000;
    expect(await a.validateSkill(input.name, 'mission-A', proof(), 'project', 1)).toContain('counts unchanged');
    const second = await a.getSkill(input.name);
    expect(second).toMatchObject({ successfulUses: 1, lastValidated: first!.lastValidated });
    expect(second!.trials).toHaveLength(1);
    expect(second!.confidence).toBeLessThanOrEqual(first!.confidence);
  });

  it('records inconclusive use neutrally and resolves it once when the same mission resumes', async () => {
    await a.saveSkill(input);
    await a.recordSkillOutcome(input.name, 'paused-mission', 'inconclusive', [], 'project', 1);
    expect(await a.getSkill(input.name)).toMatchObject({ confidence: 0, successfulUses: 0, failedUses: 0, inconclusiveUses: 1 });
    now++;
    await a.validateSkill(input.name, 'paused-mission', proof(), 'project', 1);
    expect(await a.getSkill(input.name)).toMatchObject({ successfulUses: 1, failedUses: 0, inconclusiveUses: 0,
      trials: [{ previousInconclusiveAt: 1000, outcome: 'success' }] });
    now++;
    await a.recordSkillOutcome(input.name, 'unavailable-api', 'inconclusive', [], 'project', 1);
    expect(await a.getSkill(input.name)).toMatchObject({ successfulUses: 1, failedUses: 0, inconclusiveUses: 1, status: 'validated' });
  });

  it('weakens confidence, removes automatic reuse and enforces cooldown after failing execution', async () => {
    await a.saveSkill(input, 'global');
    await a.validateSkill(input.name, 'success-A', proof(), 'global', 1);
    await b.validateSkill(input.name, 'success-B', proof(), 'global', 1);
    const before = (await a.getSkill(input.name, 'global'))!;
    now++;
    await b.recordSkillOutcome(input.name, 'failed-B', 'failure', proof('fail'), 'global', 1);
    const failed = (await a.getSkill(input.name, 'global'))!;
    expect(failed.confidence).toBeLessThan(before.confidence);
    expect(failed).toMatchObject({ successfulUses: 2, failedUses: 1, status: 'candidate' });
    expect(await a.context('WebGL')).toBe('');
    now++;
    await a.validateSkill(input.name, 'retry-A', proof(), 'global', 1);
    expect((await a.getSkill(input.name, 'global'))?.status).toBe('candidate');
    now += SKILL_FAILURE_COOLDOWN_MS;
    // More independent proof is required to clear the numerical threshold too.
    await b.validateSkill(input.name, 'retry-B', proof(), 'global', 1);
    expect((await b.getSkill(input.name, 'global'))?.status).toBe('validated');
  });

  it('does not treat a controller error or model opinion as a proven strategy failure', async () => {
    await a.saveSkill(input);
    await expect(a.recordSkillOutcome(input.name, 'bad', 'failure', [], 'project', 1)).rejects.toThrow('failing');
    await expect(a.recordSkillOutcome(input.name, 'bad', 'failure', [{ ...proof('fail')[0], source: 'model_self_review' }], 'project', 1)).rejects.toThrow('trusted runner');
    expect((await a.getSkill(input.name))?.failedUses).toBe(0);
  });

  it('ignores caller-selected confidence and counters', async () => {
    await a.saveSkill({ ...input, confidence: 0.99, successfulUses: 100 } as SkillInput);
    expect(await a.getSkill(input.name)).toMatchObject({ confidence: 0, successfulUses: 0, status: 'candidate' });
  });

  it('decays confidence with time and requires fresh trials after expiration', async () => {
    await a.saveSkill(input);
    await a.validateSkill(input.name, 'original', proof(), 'project', 1);
    const before = (await a.getSkill(input.name))!.confidence;
    now += SKILL_MAX_AGE_MS / 2;
    expect((await a.getSkill(input.name))!.confidence).toBeLessThan(before);
    now += SKILL_MAX_AGE_MS;
    expect(await a.getSkill(input.name)).toMatchObject({ status: 'stale', successfulUses: 1 });
    expect(await a.context('WebGL')).toBe('');
    now++;
    await a.validateSkill(input.name, 'fresh', proof(), 'project', 1);
    expect((await a.getSkill(input.name))?.status).toBe('validated');
  });

  it('revisions preserve earlier audit while resetting current version confidence', async () => {
    await a.saveSkill(input);
    await a.validateSkill(input.name, 'old-proof', proof(), 'project', 1);
    now++;
    await a.saveSkill({ ...input, summary: 'Use runtime frame profiling alongside Lighthouse' });
    const revised = (await a.getSkill(input.name))!;
    expect(revised).toMatchObject({ version: 2, confidence: 0, successfulUses: 0, status: 'candidate' });
    expect(revised.validation).toBeUndefined();
    expect(revised.trials).toHaveLength(1);
    expect(revised.trials[0].skillVersion).toBe(1);
    expect(revised.provenance.map(item => item.operation)).toEqual(['authored', 'revised']);
    await expect(a.validateSkill(input.name, 'late-old', proof(), 'project', 1)).rejects.toThrow('changed since its trial');
  });

  it('promotes explicit generalized candidates without copying project proof or local command content', async () => {
    await a.saveSkill(input);
    const generalized = { ...input, name: 'Reusable WebGL profiling', summary: 'Measure runtime and page performance on applicable WebGL projects' };
    await expect(a.promoteSkill(input.name, generalized)).rejects.toThrow('validated project skill');
    await a.validateSkill(input.name, 'project-proof', proof(), 'project', 1);
    await expect(a.promoteSkill(input.name, input)).rejects.toThrow('generalized content');
    await a.promoteSkill(input.name, generalized);
    const global = (await b.getSkill(generalized.name, 'global'))!;
    expect(global).toMatchObject({ successfulUses: 0, confidence: 0, status: 'candidate', trials: [],
      provenance: [{ operation: 'promoted', sources: [{ name: input.name, version: 1, scope: 'project' }] }] });
    expect(global.validation).toBeUndefined();
    expect(await b.context('WebGL')).toBe('');
  });

  it('merges compatible domains as a new candidate and never adds together trial counts', async () => {
    await a.saveSkill(input);
    await a.validateSkill(input.name, 'proof-1', proof(), 'project', 1);
    const second = { ...input, name: 'Animation frame budgets', domains: ['webgl'] };
    await a.saveSkill(second);
    await a.validateSkill(second.name, 'proof-2', proof(), 'project', 1);
    const combined = { ...input, name: 'Combined animation profiling' };
    await a.mergeSkills([input.name, second.name], combined);
    expect(await a.getSkill(combined.name)).toMatchObject({ status: 'candidate', successfulUses: 0, trials: [],
      provenance: [{ operation: 'merged', sources: [{ name: input.name }, { name: second.name }] }] });
    expect(await a.getSkill(input.name)).toMatchObject({ successfulUses: 1, status: 'deleted',
      provenance: [{ operation: 'authored' }, { operation: 'deleted', reason: `Merged into "${combined.name}" version 1` }] });
    expect((await a.getSkill(second.name))?.status).toBe('deleted');
    expect(await a.context('WebGL')).toBe('');
    await a.saveSkill({ ...second, name: 'Database plan', domains: ['sql'] });
    await expect(a.mergeSkills([combined.name, 'Database plan'], { ...combined, name: 'Bad merge' })).rejects.toThrow('shared declared domain');
  });

  it('leaves both source records intact if an atomic merge cannot create its destination', async () => {
    await a.saveSkill(input);
    await a.validateSkill(input.name, 'proof-1', proof(), 'project', 1);
    const second = { ...input, name: 'Animation frame budgets' };
    await a.saveSkill(second);
    await a.validateSkill(second.name, 'proof-2', proof(), 'project', 1);
    const destination = { ...input, name: 'Already exists' };
    await a.saveSkill(destination);
    await expect(a.mergeSkills([input.name, second.name], destination)).rejects.toThrow('new skill name');
    expect((await a.getSkill(input.name))?.status).toBe('validated');
    expect((await a.getSkill(second.name))?.status).toBe('validated');
    expect((await a.getSkill(destination.name))?.provenance.map(item => item.operation)).toEqual(['authored']);
  });

  it('keeps deleted skills out of recall and blocks resurrection by stale imports', async () => {
    const projectPath = join(directory, 'project-A');
    await a.saveSkill(input);
    await a.validateSkill(input.name, 'proof-1', proof(), 'project', 1);
    const original = await new KnowledgeStore(projectPath).list();
    const legacyPath = join(directory, 'legacy.json');
    await fs.writeFile(legacyPath, JSON.stringify(original));
    await a.deleteSkill(input.name, 'project', 'Obsolete strategy');
    expect((await a.getSkill(input.name))?.status).toBe('deleted');
    expect(await a.context('WebGL')).toBe('');
    await new KnowledgeStore(projectPath).migrateLegacyFile(legacyPath);
    expect((await a.getSkill(input.name))?.status).toBe('deleted');
    await expect(a.validateSkill(input.name, 'proof-2', proof(), 'project', 1)).rejects.toThrow('Deleted skills');
    now++;
    await a.saveSkill({ ...input, summary: 'Relearned and corrected strategy' });
    expect(await a.getSkill(input.name)).toMatchObject({ status: 'candidate', version: 2, successfulUses: 0 });
  });

  it('migrates original JSON once and makes SQLite authoritative across restarts', async () => {
    await a.saveSkill(input);
    const exported = await new KnowledgeStore(join(directory, 'project-A')).list();
    const destination = join(directory, 'legacy-global');
    await fs.mkdir(destination);
    const filename = join(destination, 'knowledge.json');
    const bytes = JSON.stringify(exported);
    await fs.writeFile(filename, bytes);
    const migrated = new KnowledgeStore(destination, 'global');
    expect((await migrated.list()).skills).toHaveLength(1);
    await migrated.deleteSkill(input.name, 'Remove imported skill');
    expect(await fs.readFile(filename, 'utf8')).toBe(bytes);
    await fs.writeFile(filename, '{now malformed');
    expect((await new KnowledgeStore(destination, 'global').list()).skills[0].status).toBe('deleted');
  });
});
