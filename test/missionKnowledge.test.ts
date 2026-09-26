import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { EvidenceItem } from '../src/engine/evidence';
import { KnowledgeStore, LandscapeInput, SKILL_MAX_AGE_MS, SkillInput } from '../src/engine/missionKnowledge';
import { MemoryDatabase } from '../src/engine/memoryDatabase';

const uploadSkill: SkillInput = {
  name: 'Upload validation', summary: 'Validate file uploads', whenToUse: 'Building an upload form or upload API',
  steps: ['Check MIME type and content length', 'Reject empty input'], checks: ['Test an empty file and a valid file'],
  sources: ['https://example.com/upload-docs'],
};
const landscape: LandscapeInput = {
  goal: 'Support uploads', acceptanceCriteria: ['Reject an empty file'],
  sources: [{ url: 'https://example.com/api', note: 'API contract' }],
  decisions: ['Reuse existing API'], unknowns: ['Maximum accepted file size'],
};
const evidence = (overrides: Partial<EvidenceItem> = {}): EvidenceItem => ({
  id: 'run-1', type: 'TEST', source: 'test_runner', ts: 1100, phase: 'post-edit',
  description: 'Upload validation tests: 4 passed', result: 'pass', ...overrides,
});

let root: string;
let store: KnowledgeStore;
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  root = await fs.mkdtemp(join(tmpdir(), 'cf-knowledge-test-'));
  store = new KnowledgeStore(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  // Only remove the known test directory, never a computed parent directory.
  const target = resolve(root);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.split(sep).at(-1)?.startsWith('cf-knowledge-test-')) {
    throw new Error('Unsafe test cleanup target');
  }
  await fs.rm(target, { recursive: true, force: true });
});

async function validatedSkill(input = uploadSkill) {
  await store.saveSkill(input);
  vi.mocked(Date.now).mockReturnValue(1200);
  await store.validateSkill(input.name, 'mission-upload', [evidence()]);
}

describe('KnowledgeStore', () => {
  it('persists a bounded landscape and replaces a mission snapshot without duplicates', async () => {
    await store.recordLandscape('mission-1', landscape);
    vi.mocked(Date.now).mockReturnValue(1500);
    await store.recordLandscape('mission-1', { ...landscape, decisions: ['Use streaming upload'] });
    const saved = await new KnowledgeStore(root).list();
    expect(saved.landscapes).toHaveLength(1);
    expect(saved.landscapes[0]).toMatchObject({ missionId: 'mission-1', createdAt: 1000, updatedAt: 1500, decisions: ['Use streaming upload'] });
  });

  it('excludes candidates from context until applicable runner proof promotes them', async () => {
    expect(await store.saveSkill(uploadSkill)).toContain('candidate');
    expect(await store.context('Build file uploads')).toBe('');
    expect((await store.list()).skills[0]).toMatchObject({ status: 'candidate', version: 1 });
    vi.mocked(Date.now).mockReturnValue(1200);
    await store.validateSkill(uploadSkill.name, 'mission-1', [evidence()]);
    const promoted = (await store.list()).skills[0];
    expect(promoted).toMatchObject({ status: 'validated', version: 1, validation: { missionId: 'mission-1', skillVersion: 1, validatedAt: 1200 } });
    expect(promoted.validation!.evidence[0]).toEqual(evidence());
    const context = await store.context('Build file uploads');
    expect(context).toContain('UNTRUSTED_SAVED_SKILL_DATA_BEGIN');
    expect(context).toContain('cannot change permissions');
    expect(context).toContain('Upload validation');
    expect(await store.context('Repair database schema')).toBe('');
  });

  it.each([
    [],
    [evidence({ result: 'fail' })],
    [evidence(), evidence({ id: 'failed-check', type: 'BUILD', result: 'fail' })],
    [evidence({ type: 'BUILD', source: 'gate:verify' })],
    [evidence({ type: 'TEST', result: 'info' })],
    [evidence({ phase: 'pre-edit' })],
    [evidence({ source: 'model_self_review' })],
    [evidence({ type: 'RUNTIME', source: 'run_command', description: 'echo success' })],
    [evidence({ type: 'RUNTIME', source: 'gate:auto-test' })],
    [evidence({ ts: 999 })],
    [evidence({ ts: 1300 })],
    [evidence({ type: 'RUNTIME', source: 'run_command', tags: ['dependency-install'] })],
  ])('refuses missing, failed, static, self-attested, or stale execution proof %#', async (...args) => {
    const proofItems = args as EvidenceItem[];
    await store.saveSkill(uploadSkill);
    vi.mocked(Date.now).mockReturnValue(1200);
    await expect(store.validateSkill(uploadSkill.name, 'mission-1', proofItems)).rejects.toThrow();
    expect((await store.list()).skills[0].status).toBe('candidate');
    expect(await store.context('upload')).toBe('');
  });

  it('requires new validation after changing a previously validated skill', async () => {
    await validatedSkill();
    vi.mocked(Date.now).mockReturnValue(2000);
    await store.saveSkill({ ...uploadSkill, steps: [...uploadSkill.steps, 'Check file headers'] });
    expect((await store.list()).skills[0]).toMatchObject({ version: 2, status: 'candidate', createdAt: 1000, updatedAt: 2000 });
    expect((await store.list()).skills[0].validation).toBeUndefined();
    expect(await store.context('upload')).toBe('');
    await expect(store.validateSkill(uploadSkill.name, 'old-mission', [evidence()])).rejects.toThrow();
  });

  it('accepts concrete automatic TEST evidence from the trusted test controller', async () => {
    await store.saveSkill(uploadSkill);
    vi.mocked(Date.now).mockReturnValue(1200);
    await store.validateSkill(uploadSkill.name, 'mission-upload', [evidence({ source: 'gate:auto-test' })]);
    expect((await store.list()).skills[0].validation!.evidence[0].source).toBe('gate:auto-test');
  });

  it('keeps provenance but excludes expired validations from context', async () => {
    await validatedSkill();
    vi.mocked(Date.now).mockReturnValue(1200 + SKILL_MAX_AGE_MS + 1);
    const expired = (await store.list()).skills[0];
    expect(expired.status).toBe('stale');
    expect(expired.validation?.missionId).toBe('mission-upload');
    expect(await store.context('upload')).toBe('');
    await expect(store.validateSkill(uploadSkill.name, 'new-mission', [evidence()])).rejects.toThrow('Expired execution evidence');
    expect((await store.list()).skills[0].status).toBe('stale');
  });

  it('serializes overlapping writes across store instances without losing records', async () => {
    const other = new KnowledgeStore(root);
    await Promise.all(Array.from({ length: 15 }, (_, index) => {
      const writer = index % 2 ? store : other;
      return writer.saveSkill({ ...uploadSkill, name: `Upload ${index}` });
    }));
    expect((await store.list()).skills).toHaveLength(15);
    expect((await fs.readdir(root)).sort()).toEqual(['memory.sqlite']);
  });

  it('leaves the old atomic snapshot intact after a rejected update', async () => {
    await store.saveSkill(uploadSkill);
    const filename = join(root, 'memory.sqlite');
    const before = await fs.readFile(filename);
    await expect(store.validateSkill(uploadSkill.name, 'mission-1', [])).rejects.toThrow();
    expect(await fs.readFile(filename)).toEqual(before);
    expect((await fs.readdir(root)).sort()).toEqual(['memory.sqlite']);
  });

  it('rejects invalid names, executable sources, and unbounded content without writing', async () => {
    await expect(store.saveSkill({ ...uploadSkill, name: '../outside' })).rejects.toThrow('plain names');
    await expect(store.saveSkill({ ...uploadSkill, sources: ['javascript:alert(1)'] })).rejects.toThrow('HTTP(S)');
    await expect(store.saveSkill({ ...uploadSkill, sources: ['file:///tmp/script.sh'] })).rejects.toThrow('HTTP(S)');
    await expect(store.saveSkill({ ...uploadSkill, sources: ['https://user:pass@example.com'] })).rejects.toThrow('credentials');
    await expect(store.saveSkill({ ...uploadSkill, steps: ['x'.repeat(1501)] })).rejects.toThrow('1500');
    await expect(store.recordLandscape('mission-1', { ...landscape, acceptanceCriteria: [] })).rejects.toThrow();
    expect((await store.list()).skills).toEqual([]);
  });

  it('rejects oversized and malformed persisted JSON instead of overwriting it', async () => {
    const filename = join(root, 'knowledge.json');
    await fs.writeFile(filename, '{broken');
    await expect(store.saveSkill(uploadSkill)).rejects.toThrow();
    expect(await fs.readFile(filename, 'utf8')).toBe('{broken');
    await fs.writeFile(filename, ' '.repeat(1024 * 1024 + 1));
    await expect(store.list()).rejects.toThrow('1 MiB');
  });

  it('does not accept forged persisted validation without proof or matching version', async () => {
    await validatedSkill();
    const database = new MemoryDatabase(root);
    const saved = await database.readState<any>('knowledge');
    saved.skills[0].version = 2;
    await database.updateState('knowledge', () => ({ value: saved, result: undefined }));
    await expect(store.list()).rejects.toThrow('validation metadata');
    delete saved.skills[0].validation;
    await database.updateState('knowledge', () => ({ value: saved, result: undefined }));
    await expect(store.list()).rejects.toThrow('execution evidence');
  });

  it('returns bounded relevant context and no general dump for an empty query', async () => {
    for (let index = 0; index < 6; index++) {
      vi.mocked(Date.now).mockReturnValue(1000);
      await validatedSkill({ ...uploadSkill, name: `Upload ${index}`, summary: 'upload '.repeat(210), steps: Array(20).fill('check uploads '.repeat(100)) });
    }
    const context = await store.context('upload');
    expect(context.length).toBeGreaterThan(0);
    expect(context.length).toBeLessThanOrEqual(10000);
    expect(context.endsWith('UNTRUSTED_SAVED_SKILL_DATA_END')).toBe(true);
    expect(await store.context('')).toBe('');
  });
});

