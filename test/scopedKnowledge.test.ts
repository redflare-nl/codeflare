import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { spawn } from 'child_process';
import { build } from 'esbuild';
import { EvidenceItem } from '../src/engine/evidence';
import { KnowledgeStore, LandscapeInput, SkillInput } from '../src/engine/missionKnowledge';
import { ScopedKnowledgeStore } from '../src/engine/scopedKnowledge';

const skill: SkillInput = {
  name: 'Upload validation', summary: 'Validate uploads', whenToUse: 'Building upload forms',
  steps: ['Reject empty input'], checks: ['An empty upload fails'], sources: ['https://example.com/docs'],
};
const landscape: LandscapeInput = {
  goal: 'Upload customer documents', acceptanceCriteria: ['Reject empty input'], sources: [],
  decisions: ['Keep private files in this project'], unknowns: [],
};
const evidence = (): EvidenceItem[] => [{ id: 'e1', type: 'TEST', source: 'gate:auto-test', ts: 1100,
  phase: 'post-edit', result: 'pass', description: 'Private command C:\\customers\\secret-project\\upload.test.ts: 4 passed' }];

let root: string;
let projectA: string;
let projectB: string;
let globalDirectory: string;
let repository: string;
let a: ScopedKnowledgeStore;
let b: ScopedKnowledgeStore;
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  root = await fs.mkdtemp(join(tmpdir(), 'cf-scoped-knowledge-'));
  projectA = join(root, 'vscode', 'workspace-A', 'knowledge');
  projectB = join(root, 'vscode', 'workspace-B', 'knowledge');
  globalDirectory = join(root, 'vscode', 'global', 'knowledge');
  repository = join(root, 'repository');
  await fs.mkdir(repository);
  a = new ScopedKnowledgeStore(projectA, globalDirectory, repository);
  b = new ScopedKnowledgeStore(projectB, globalDirectory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  const target = resolve(root);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.split(sep).at(-1)?.startsWith('cf-scoped-knowledge-')) {
    throw new Error('Unsafe test cleanup target');
  }
  await fs.rm(target, { recursive: true, force: true });
});

async function validate(store: ScopedKnowledgeStore, scope: 'project' | 'global' = 'project') {
  vi.mocked(Date.now).mockReturnValue(1000);
  await store.saveSkill(skill, scope);
  vi.mocked(Date.now).mockReturnValue(1200);
  await store.validateSkill(skill.name, 'mission-1', evidence(), scope, 1);
  if (scope === 'global') { await b.validateSkill(skill.name, 'mission-B', evidence(), scope, 1); }
}

describe('ScopedKnowledgeStore', () => {
  it('writes only to explicit VS Code storage directories, leaving the repository untouched', async () => {
    await a.recordLandscape('mission-A', landscape);
    await a.saveSkill(skill);
    expect(await fs.readdir(repository)).toEqual([]);
    expect((await fs.readdir(projectA)).sort()).toEqual(['memory.sqlite']);
    expect((await a.list()).landscapes[0].goal).toBe(landscape.goal);
  });

  it('keeps project A landscapes and skills out of project B', async () => {
    await a.recordLandscape('mission-A', landscape);
    await validate(a);
    expect((await a.list()).skills).toHaveLength(1);
    expect(await a.context('upload')).toContain('Upload validation');
    expect(await b.list()).toEqual({ schemaVersion: 1, landscapes: [], skills: [] });
    expect(await b.context('upload')).toBe('');
  });

  it('shares explicitly global validated skills across workspaces with opaque provenance', async () => {
    await validate(a, 'global');
    const reused = await b.getSkill(skill.name, 'global');
    expect(reused).toMatchObject({ scope: 'global', version: 1, status: 'validated', successfulUses: 2, validation: { missionId: 'mission-B' } });
    expect(reused!.workspaceId).toMatch(/^[a-f0-9]{64}$/);
    expect(reused!.validation!.workspaceId).not.toBe(reused!.workspaceId);
    expect(reused!.validation!.evidence[0]).toMatchObject({ id: 'e1', source: 'gate:auto-test', type: 'TEST', ts: 1100, result: 'pass' });
    const persisted = JSON.stringify(reused);
    expect(persisted).not.toContain('secret-project');
    expect(persisted).not.toContain(projectA);
    expect(persisted).not.toContain(repository);
    expect(await b.context('upload')).toContain('"scope":"global"');
    expect((await b.list()).landscapes).toEqual([]);
  });

  it('does not validate the wrong scope when project and global names match', async () => {
    await a.saveSkill(skill);
    await a.saveSkill({ ...skill, summary: 'Generic upload validation' }, 'global');
    vi.mocked(Date.now).mockReturnValue(1200);
    await a.validateSkill(skill.name, 'mission-project', evidence(), 'project', 1);
    expect((await a.getSkill(skill.name))?.status).toBe('validated');
    expect((await a.getSkill(skill.name, 'global'))?.status).toBe('candidate');
    expect((await a.list()).skills.map(entry => entry.scope)).toEqual(['project', 'global']);
    expect(await b.context('upload')).toBe('');
  });

  it('checks the expected version under the shared store lock', async () => {
    await a.saveSkill(skill, 'global');
    const trial = await a.getSkill(skill.name, 'global');
    await b.saveSkill({ ...skill, steps: ['Check MIME type', 'Reject empty input'] }, 'global');
    vi.mocked(Date.now).mockReturnValue(1200);
    await expect(a.validateSkill(skill.name, 'old-trial', evidence(), 'global', trial!.version)).rejects.toThrow('changed since its trial');
    expect((await b.getSkill(skill.name, 'global'))?.status).toBe('candidate');
  });

  it('allows global memory without a workspace and refuses a repository fallback', async () => {
    const emptyWindow = new ScopedKnowledgeStore(undefined, globalDirectory, repository);
    await emptyWindow.saveSkill(skill, 'global');
    expect((await emptyWindow.list()).skills[0].scope).toBe('global');
    await expect(emptyWindow.saveSkill(skill)).rejects.toThrow('requires an open workspace');
    await expect(emptyWindow.recordLandscape('mission-X', landscape)).rejects.toThrow('requires an open workspace');
    expect(await fs.readdir(repository)).toEqual([]);
  });

  it('rejects invalid or identical scopes without falling back to project storage', async () => {
    expect(() => new ScopedKnowledgeStore(projectA, projectA)).toThrow('different storage');
    await expect(a.saveSkill(skill, 'session' as 'project')).rejects.toThrow('scope must be');
    expect(await fs.readdir(repository)).toEqual([]);
  });

  it('uses one combined 10k context bound and labels same-name scopes', async () => {
    await validate(a, 'project');
    await validate(a, 'global');
    for (let index = 0; index < 6; index++) {
      const scope = index % 2 ? 'project' : 'global';
      vi.mocked(Date.now).mockReturnValue(1000);
      const entry = { ...skill, name: `Upload ${index}`, summary: 'upload '.repeat(200), steps: Array(20).fill('Check input '.repeat(100)) };
      await a.saveSkill(entry, scope);
      vi.mocked(Date.now).mockReturnValue(1200);
      await a.validateSkill(entry.name, `mission-${index}`, evidence(), scope, 1);
      if (scope === 'global') { await b.validateSkill(entry.name, `mission-B-${index}`, evidence(), scope, 1); }
    }
    const context = await a.context('upload');
    expect(context).toContain('"scope":"project"');
    expect(context).toContain('"scope":"global"');
    expect(context.length).toBeLessThanOrEqual(10000);
    expect(context.endsWith('UNTRUSTED_SAVED_SKILL_DATA_END')).toBe(true);
  });

  it('serializes writes to shared global memory from separate workspace controllers', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? a : b).saveSkill({ ...skill, name: `Upload ${index}` }, 'global')));
    expect((await a.list()).skills).toHaveLength(20);
    expect((await b.list()).skills).toHaveLength(20);
    expect((await fs.readdir(globalDirectory)).sort()).toEqual(['memory.sqlite']);
  });

  describe('clearScope', () => {
    it('clears the project scope without touching global or another workspace', async () => {
      await a.saveSkill(skill);
      await a.saveSkill({ ...skill, summary: 'Generic upload validation' }, 'global');
      await b.saveSkill({ ...skill, name: 'Workspace B skill' });

      const cleared = await a.clearScope('project');
      expect(cleared.project?.states).toBeGreaterThan(0);
      expect(cleared.global).toBeUndefined();

      expect((await a.list()).skills.map(s => s.scope)).toEqual(['global']);
      expect((await b.list()).skills.filter(s => s.scope === 'project')).toHaveLength(1);
    });

    it('clears the global scope for every workspace that shares it', async () => {
      await a.saveSkill(skill, 'global');
      await a.saveSkill({ ...skill, name: 'Project only' });

      const cleared = await a.clearScope('global');
      expect(cleared.global?.states).toBeGreaterThan(0);
      expect(cleared.project).toBeUndefined();

      expect((await a.list()).skills.map(s => s.scope)).toEqual(['project']);
      expect((await b.list()).skills).toHaveLength(0);
    });

    it('clears both scopes with "all"', async () => {
      await a.saveSkill(skill);
      await a.saveSkill({ ...skill, summary: 'Generic upload validation' }, 'global');

      const cleared = await a.clearScope('all');
      expect(cleared.project).toBeDefined();
      expect(cleared.global).toBeDefined();
      expect((await a.list()).skills).toHaveLength(0);
    });

    it('does not let a legacy knowledge file resurrect cleared project data', async () => {
      // The pre-SQLite layout kept skills in .codeflare/knowledge.json. Clearing
      // must neutralise it, or the next read re-imports what the user deleted.
      // Produce the legacy file with a real store, so the fixture can never drift
      // from the schema the migration actually accepts.
      const legacyDirectory = join(repository, '.codeflare');
      await fs.mkdir(legacyDirectory, { recursive: true });
      const source = join(root, 'legacy-source');
      await new KnowledgeStore(source).saveSkill({ ...skill, name: 'Legacy skill' });
      const snapshot = await new KnowledgeStore(source).list();
      await fs.writeFile(join(legacyDirectory, 'knowledge.json'), JSON.stringify(snapshot));
      const store = new ScopedKnowledgeStore(projectA, globalDirectory, repository);
      expect((await store.list()).skills.map(s => s.name)).toContain('Legacy skill');

      const cleared = await store.clearScope('project');
      expect(cleared.project?.legacyFile).toMatch(/knowledge\.json\.cleared-\d+$/);
      expect((await store.list()).skills).toHaveLength(0);

      // A freshly constructed store must not re-import it either.
      expect((await new ScopedKnowledgeStore(projectA, globalDirectory, repository).list()).skills).toHaveLength(0);
      // The data is archived rather than destroyed, so a mistake stays recoverable.
      expect((await fs.readdir(legacyDirectory)).some(f => f.startsWith('knowledge.json.cleared-'))).toBe(true);
    });

    it('accepts new knowledge after a clear', async () => {
      await a.saveSkill(skill);
      await a.clearScope('project');
      await a.saveSkill({ ...skill, name: 'After the clear' });
      expect((await a.list()).skills.map(s => s.name)).toEqual(['After the clear']);
    });

    it('reports a missing project store instead of silently succeeding', async () => {
      const globalOnly = new ScopedKnowledgeStore(undefined, globalDirectory);
      await expect(globalOnly.clearScope('project')).rejects.toThrow(/requires an open workspace/);
      // "all" still clears what it can reach.
      await a.saveSkill(skill, 'global');
      const cleared = await globalOnly.clearScope('all');
      expect(cleared.project).toBeUndefined();
      expect(cleared.global).toBeDefined();
    });
  });
});

describe('legacy project knowledge migration', () => {
  async function legacyStore() {
    const fixture = join(root, 'legacy-fixture');
    const legacy = new KnowledgeStore(fixture);
    await legacy.recordLandscape('legacy-mission', landscape);
    await legacy.saveSkill(skill);
    await fs.mkdir(join(repository, '.codeflare'), { recursive: true });
    const exportLegacy = async () => fs.writeFile(join(repository, '.codeflare', 'knowledge.json'), JSON.stringify(await legacy.list()));
    await exportLegacy();
    return { saveSkill: async (input: SkillInput) => { await legacy.saveSkill(input); await exportLegacy(); } };
  }

  it('migrates once into workspace storage, keeps legacy bytes intact, and never promotes globally', async () => {
    await legacyStore();
    const source = join(repository, '.codeflare', 'knowledge.json');
    const oldBytes = await fs.readFile(source, 'utf8');
    expect((await a.list()).skills[0]).toMatchObject({ scope: 'project', name: skill.name });
    expect(await fs.readFile(source, 'utf8')).toBe(oldBytes);
    const destination = await new KnowledgeStore(projectA).list();
    expect(destination.migrations).toHaveLength(1);
    expect(destination.migrations![0]).toMatchObject({ importedSkills: 1, importedLandscapes: 1, conflictingSkills: [], conflictingMissions: [] });
    expect((await b.list()).skills).toEqual([]);
    await fs.writeFile(source, '{broken after completed migration');
    const restarted = new ScopedKnowledgeStore(projectA, globalDirectory, repository);
    expect((await restarted.list()).skills).toHaveLength(1);
    expect((await new KnowledgeStore(projectA).list()).migrations).toHaveLength(1);
  });

  it('merges without overwriting destination records and records conflict identities', async () => {
    const legacy = await legacyStore();
    await legacy.saveSkill({ ...skill, name: 'Legacy upload retry' });
    const destination = new KnowledgeStore(projectA);
    await destination.saveSkill({ ...skill, summary: 'New destination summary' });
    await destination.recordLandscape('legacy-mission', { ...landscape, goal: 'New destination goal' });
    const source = join(repository, '.codeflare', 'knowledge.json');
    const oldBytes = await fs.readFile(source, 'utf8');
    const migrated = await a.list();
    expect(migrated.skills).toHaveLength(2);
    expect(migrated.skills.find(entry => entry.name === skill.name)?.summary).toBe('New destination summary');
    expect(migrated.landscapes[0].goal).toBe('New destination goal');
    expect((await destination.list()).migrations![0]).toMatchObject({ importedSkills: 1, importedLandscapes: 0, conflictingSkills: [skill.name], conflictingMissions: ['legacy-mission'] });
    expect(await fs.readFile(source, 'utf8')).toBe(oldBytes);
  });

  it('fails visibly on malformed legacy data without shadowing it with new project writes', async () => {
    await fs.mkdir(join(repository, '.codeflare'));
    const source = join(repository, '.codeflare', 'knowledge.json');
    await fs.writeFile(source, '{broken');
    await expect(a.list()).rejects.toThrow('could not be migrated');
    await expect(a.saveSkill(skill)).rejects.toThrow('before saving new project knowledge');
    expect(await fs.readFile(source, 'utf8')).toBe('{broken');
    await expect(fs.readFile(join(projectA, 'knowledge.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    // The separate global store still works; repair unlocks project operations.
    await a.saveSkill(skill, 'global');
    await fs.writeFile(source, JSON.stringify({ schemaVersion: 1, landscapes: [], skills: [] }));
    await a.saveSkill({ ...skill, name: 'Project upload' });
    expect((await a.list()).skills).toHaveLength(2);
  });

  it('leaves an existing destination unchanged when legacy validation fails', async () => {
    const destination = new KnowledgeStore(projectA);
    await destination.saveSkill(skill);
    const before = await fs.readFile(join(projectA, 'memory.sqlite'));
    await fs.mkdir(join(repository, '.codeflare'));
    await fs.writeFile(join(repository, '.codeflare', 'knowledge.json'), JSON.stringify({ schemaVersion: 999, landscapes: [], skills: [] }));
    await expect(a.recordLandscape('new-mission', landscape)).rejects.toThrow('could not be migrated');
    expect(await fs.readFile(join(projectA, 'memory.sqlite'))).toEqual(before);
  });

  it('keeps the migration marker and records consistent under overlapping migration and writes', async () => {
    await legacyStore();
    const other = new ScopedKnowledgeStore(projectA, globalDirectory, repository);
    await Promise.all([a.list(), other.list(), a.saveSkill({ ...skill, name: 'After migration' }), other.recordLandscape('new-mission', landscape)]);
    const saved = await new KnowledgeStore(projectA).list();
    expect(saved.migrations).toHaveLength(1);
    expect(saved.skills.map(entry => entry.name).sort()).toEqual(['After migration', skill.name]);
    expect(saved.landscapes).toHaveLength(2);
  });

  it('does not import a legacy store when there is no workspace storage', async () => {
    await legacyStore();
    const emptyWindow = new ScopedKnowledgeStore(undefined, globalDirectory, repository);
    expect(await emptyWindow.list()).toEqual({ schemaVersion: 1, landscapes: [], skills: [] });
  });
});

it('preserves global writes made by independent Node processes using the disk lock', async () => {
  const bundle = join(root, 'knowledge.cjs');
  await build({ entryPoints: [resolve('src/engine/missionKnowledge.ts')], outfile: bundle, platform: 'node', format: 'cjs', bundle: true });
  await fs.copyFile(require.resolve('sql.js/dist/sql-wasm.wasm'), join(root, 'sql-wasm.wasm'));
  const childScript = `
    const { KnowledgeStore } = require(process.argv[1]);
    const store = new KnowledgeStore(process.argv[2]);
    (async () => {
      for (let i = 0; i < 12; i++) {
        await store.saveSkill({ name: process.argv[3] + ' ' + i, summary: 'Uploads', whenToUse: 'Uploads', steps: ['Validate input'], checks: ['Test input'], sources: [] });
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const writer = (label: string) => new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['-e', childScript, bundle, globalDirectory, label], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolvePromise() : reject(new Error(stderr || `Writer exited ${code}`)));
  });
  await Promise.all([writer('Window A'), writer('Window B'), writer('Window C')]);
  expect((await new KnowledgeStore(globalDirectory).list()).skills).toHaveLength(36);
  expect((await fs.readdir(globalDirectory)).sort()).toEqual(['memory.sqlite']);
});
