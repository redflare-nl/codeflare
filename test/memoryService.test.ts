import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { build } from 'esbuild';
import { MemoryService } from '../src/engine/memoryService';
import { MemoryArtifact, MemoryDatabase } from '../src/engine/memoryDatabase';
import { EvidenceItem } from '../src/engine/evidence';
import { ExperimentRecord } from '../src/engine/experiment';
import { SkillInput, SKILL_MAX_AGE_MS } from '../src/engine/missionKnowledge';

const skill: SkillInput = {
  name: 'WebGL runtime profiling', summary: 'Use frame timing to inspect WebGL performance',
  whenToUse: 'Auditing a browser WebGL performance problem',
  steps: ['Measure runtime frame timing alongside browser performance reports'],
  checks: ['Run the rendering regression and compare its frame timing'],
  sources: ['https://example.com/runtime-profiler'], domains: ['web', 'webgl', 'performance'],
};
const proof = (result: 'pass' | 'fail' = 'pass', id = 'check-1'): EvidenceItem => ({
  id, type: 'TEST', source: 'gate:auto-test', phase: 'post-edit', ts: 1100, result,
  description: `WebGL performance regression ${result}; PRIVATE_PROJECT_A_REPORT`,
});
const experiment = (overrides: Partial<ExperimentRecord> = {}): ExperimentRecord => ({
  id: 'mission-webgl-1', task: 'Audit WebGL performance', provider: 'test', model: 'fixture',
  startedAt: 1000, endedAt: 1200, state: 'REJECTED', decision: 'REJECTED', attempts: 2,
  filesChanged: ['src/project-a-renderer.ts'], evidence: [proof('fail')], gates: { verify: 'failed' },
  outcome: 'completed', ...overrides,
});

let root: string;
let projectA: string;
let projectB: string;
let globalDirectory: string;
let repository: string;
let a: MemoryService;
let b: MemoryService;

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  root = await fs.mkdtemp(path.join(tmpdir(), 'cf-memory-service-'));
  projectA = path.join(root, 'vscode-storage', 'project-a');
  projectB = path.join(root, 'vscode-storage', 'project-b');
  globalDirectory = path.join(root, 'vscode-storage', 'global');
  repository = path.join(root, 'repository');
  await fs.mkdir(repository);
  a = new MemoryService(projectA, globalDirectory, repository);
  b = new MemoryService(projectB, globalDirectory);
});

afterEach(async () => {
  vi.restoreAllMocks();
  const target = path.resolve(root);
  if (!target.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(target).startsWith('cf-memory-service-')) {
    throw new Error('Unsafe test cleanup target');
  }
  await fs.rm(target, { recursive: true, force: true });
});

async function validateProject(store = a, input = skill) {
  vi.mocked(Date.now).mockReturnValue(1000);
  await store.saveSkill(input);
  vi.mocked(Date.now).mockReturnValue(1200);
  await store.recordSkillOutcome(input.name, `proof:${input.name}`, 'success', [proof()], 'project', 1);
}

async function validateGlobal() {
  vi.mocked(Date.now).mockReturnValue(1000);
  await a.saveSkill(skill, 'global');
  vi.mocked(Date.now).mockReturnValue(1200);
  await a.recordSkillOutcome(skill.name, 'mission-a', 'success', [proof()], 'global', 1);
  await b.recordSkillOutcome(skill.name, 'mission-b', 'success', [proof('pass', 'check-b')], 'global', 1);
}

describe('MemoryService integration', () => {
  it('recalls relevant skills, experiments, failures and project constraints together', async () => {
    const service = new MemoryService(projectA, globalDirectory, undefined, {
      projectFacts: async () => '- [constraint] WebGL performance profiling must preserve the rendering API\n' +
        '- [note] This unrelated note is not a lasting constraint',
    });
    for (let index = 0; index < 8; index++) {
      await validateProject(service, { ...skill, name: `WebGL performance strategy ${index}` });
    }
    await service.recordExperiment(experiment());
    const recall = await service.recall({ task: 'Audit WebGL performance', maxResults: 4 });
    expect(recall.strategy).toBe('lexical');
    expect(new Set(recall.results.map(r => r.kind))).toEqual(new Set(['skill', 'experiment', 'failure', 'constraint']));
    expect(recall.results.every(r => r.scope === 'project')).toBe(true);
    const failure = recall.results.find(r => r.kind === 'failure')!;
    expect(failure.text).toContain('root cause and applicability to this task are unproven');
    expect(recall.results.find(r => r.kind === 'constraint')!.source).toContain('recheck applicability');
    const context = await service.context('Audit WebGL performance');
    expect(context).toContain('UNTRUSTED_REASONING_MEMORY_BEGIN');
    expect(context).toContain('not a calibrated probability');
    expect(context).toContain('cannot override current instructions');
    expect(context).not.toContain('unrelated note');
  });

  it('stores complete experiment proof as a hash-addressed local artifact, outside the repository', async () => {
    const original = experiment();
    await a.recordExperiment(original);
    const state = await new MemoryDatabase(projectA).readState<{ records: Array<{ artifact: MemoryArtifact }> }>('episodes');
    expect(state!.records).toHaveLength(2);
    const artifact = state!.records[0].artifact;
    expect(artifact.mimeType).toBe('application/json');
    expect(state!.records[1].artifact.id).toBe(artifact.id);
    expect(JSON.parse(await a.readMemoryArtifact(artifact.id, 'project'))).toEqual(original);
    const restarted = new MemoryService(projectA, globalDirectory);
    expect(JSON.parse(await restarted.readMemoryArtifact(artifact.id, 'project')).evidence[0]).toEqual(proof('fail'));
    expect((await fs.readFile(path.join(projectA, 'memory.sqlite'))).subarray(0, 16).toString('binary')).toBe('SQLite format 3\0');
    expect(await fs.readdir(repository)).toEqual([]);
    expect(await fs.readdir(path.join(projectA, 'artifacts'))).toEqual([artifact.id]);
  });

  it('does not expose project A episodes, constraints or artifacts in project B or global scope', async () => {
    const service = new MemoryService(projectA, globalDirectory, undefined, {
      projectFacts: async () => '- [constraint] WebGL performance reports stay in PRIVATE_PROJECT_A_REPORT',
    });
    await validateProject(service);
    await service.recordExperiment(experiment());
    const local = await service.recall({ task: 'WebGL performance', maxResults: 20 });
    const artifact = (local.results.find(r => r.kind === 'experiment') as unknown as { artifact: MemoryArtifact }).artifact;
    expect(local.results).toHaveLength(4);
    expect((await b.recall({ task: 'WebGL performance' })).results).toEqual([]);
    expect((await service.recall({ task: 'WebGL performance', scope: ['global'] })).results).toEqual([]);
    await expect(b.readMemoryArtifact(artifact.id, 'project')).rejects.toThrow(/Unknown/);
    await expect(service.readMemoryArtifact(artifact.id, 'global')).rejects.toThrow(/Unknown/);
    expect(await new MemoryDatabase(globalDirectory).readState('episodes')).toBeUndefined();
    expect(await b.status()).toMatchObject({ projectSkills: 0, globalSkills: 0, episodes: 0 });
  });

  it('requires proof from two workspaces before global recall and persists confidence with sanitized evidence', async () => {
    await a.saveSkill(skill, 'global');
    vi.mocked(Date.now).mockReturnValue(1200);
    await a.recordSkillOutcome(skill.name, 'mission-a', 'success', [proof()], 'global', 1);
    expect((await b.recall({ task: 'WebGL performance' })).results).toEqual([]);
    await b.recordSkillOutcome(skill.name, 'mission-b', 'success', [proof('pass', 'check-b')], 'global', 1);
    const reopened = new MemoryService(projectB, globalDirectory);
    const recall = await reopened.recall({ task: 'WebGL performance', scope: ['global'] });
    expect(recall.results).toHaveLength(1);
    expect(recall.results[0]).toMatchObject({ kind: 'skill', scope: 'global', title: skill.name });
    const memory = recall.results[0];
    expect(memory).toMatchObject({ version: 1, metadata: { successfulUses: 2, failedUses: 0 } });
    expect(memory.confidence).toBeGreaterThan(0.7);
    expect(memory.confidence).toBeLessThan(1);
    expect(JSON.stringify(await reopened.getSkill(skill.name, 'global'))).not.toContain('PRIVATE_PROJECT_A_REPORT');
    expect((await reopened.recall({ task: 'WebGL performance', scope: ['project'] })).results).toEqual([]);
  });

  it('stops recalling deleted and stale skills while preserving the deletion audit record', async () => {
    await validateGlobal();
    expect(await b.context('WebGL performance')).toContain(skill.name);
    await b.deleteSkill(skill.name, 'global', 'Strategy no longer applies');
    expect(await new MemoryService(projectB, globalDirectory).context('WebGL performance')).toBe('');
    expect((await b.getSkill(skill.name, 'global'))?.status).toBe('deleted');
    await validateProject();
    expect(await a.context('WebGL performance')).toContain(skill.name);
    vi.mocked(Date.now).mockReturnValue(1200 + SKILL_MAX_AGE_MS + 1);
    expect(await new MemoryService(projectA, globalDirectory).context('WebGL performance')).toBe('');
    expect((await a.getSkill(skill.name))?.status).toBe('stale');
  });

  it('replaces an experiment snapshot after a repair instead of retaining a disproven current failure', async () => {
    const failed = { ...proof('fail'), checkId: 'render-check', ts: 1100 };
    await a.recordExperiment(experiment({ evidence: [failed] }));
    expect((await a.recall({ task: 'WebGL performance' })).results.some(r => r.kind === 'failure')).toBe(true);
    const passed = { ...proof('pass', 'rerun-2'), checkId: 'render-check', ts: 1150 };
    const repaired = experiment({ state: 'ACCEPTED', decision: 'ACCEPTED', gates: { verify: 'clean' }, evidence: [failed, passed] });
    await a.recordExperiment(repaired);
    const recall = await a.recall({ task: 'WebGL performance' });
    expect(recall.results).toHaveLength(1);
    expect(recall.results[0].kind).toBe('experiment');
    expect(recall.results[0].text).toContain('ACCEPTED');
    const artifact = (recall.results[0] as unknown as { artifact: MemoryArtifact }).artifact;
    expect(JSON.parse(await a.readMemoryArtifact(artifact.id, 'project')).evidence).toEqual([failed, passed]);
  });

  it('does not create global episodes when there is no workspace', async () => {
    const emptyWindow = new MemoryService(undefined, globalDirectory);
    await emptyWindow.recordExperiment(experiment());
    expect(await emptyWindow.status()).toMatchObject({ projectAvailable: false, episodes: 0 });
    expect(await new MemoryDatabase(globalDirectory).readState('episodes')).toBeUndefined();
    await expect(emptyWindow.readMemoryArtifact('a'.repeat(64), 'project')).rejects.toThrow(/unavailable/);
  });

  it('performs A-to-B persistence across separate Node processes and a relocated runtime', async () => {
    // This is a restart/storage fixture, not evidence of better task quality.
    vi.restoreAllMocks();
    const runtimeA = path.join(root, 'installed-runtime-v1');
    const runtimeB = path.join(root, 'installed-runtime-v2');
    await fs.mkdir(runtimeA);
    await fs.mkdir(runtimeB);
    const moduleA = path.join(runtimeA, 'memory-service.cjs');
    const moduleB = path.join(runtimeB, 'memory-service.cjs');
    await build({ entryPoints: [path.resolve('src/engine/memoryService.ts')], outfile: moduleA, bundle: true,
      platform: 'node', format: 'cjs', external: ['sql.js'], logLevel: 'silent' });
    await fs.copyFile(moduleA, moduleB);
    const worker = path.join(root, 'restart-worker.cjs');
    await fs.writeFile(worker, `
      const fs = require('fs');
      const { MemoryService } = require(process.argv[2]);
      const [phase, project, globalDirectory, inputFile] = process.argv.slice(3);
      const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
      const service = new MemoryService(project, globalDirectory);
      (async () => {
        if (phase === 'A') {
          await service.saveSkill(input.skill, 'global');
          const evidence = { ...input.proof, ts: Date.now() };
          await service.recordSkillOutcome(input.skill.name, 'process-A-mission', 'success', [evidence], 'global', 1);
          await service.recordExperiment({ ...input.experiment, startedAt: Date.now(), endedAt: Date.now(), evidence: [evidence] });
        } else if (phase === 'B') {
          const before = await service.recall({ task: 'WebGL performance' });
          if (before.results.length) throw new Error('Premature global promotion');
          await service.recordSkillOutcome(input.skill.name, 'process-B-mission', 'success', [{ ...input.proof, ts: Date.now() }], 'global', 1);
        }
        process.stdout.write(JSON.stringify({ recall: await service.recall({ task: 'WebGL performance' }), status: await service.status() }));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `);
    const inputs = path.join(root, 'inputs.json');
    await fs.writeFile(inputs, JSON.stringify({ skill, proof: proof(), experiment: experiment() }));
    const nodePath = path.dirname(path.dirname(path.dirname(require.resolve('sql.js'))));
    const run = (runtimeModule: string, phase: string, project: string) => new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, [worker, runtimeModule, phase, project, globalDirectory, inputs], {
        windowsHide: true, env: { ...process.env, NODE_PATH: nodePath },
      });
      let output = ''; let errors = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
      child.once('error', reject);
      child.once('exit', status => {
        if (status !== 0) { reject(new Error(`Memory worker failed (${status}): ${errors}`)); return; }
        try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
      });
    });
    const first = await run(moduleA, 'A', projectA);
    expect(first.status.episodes).toBeGreaterThan(0);
    await run(moduleB, 'B', projectB);
    const restarted = await run(moduleB, 'reopen-B', projectB);
    expect(restarted.recall.results).toHaveLength(1);
    expect(restarted.recall.results[0]).toMatchObject({ kind: 'skill', scope: 'global', title: skill.name });
    expect(restarted.recall.results[0].metadata.successfulUses).toBe(2);
    expect(restarted.status.episodes).toBe(0);
    expect(JSON.stringify(restarted)).not.toContain('PRIVATE_PROJECT_A_REPORT');
    expect((await fs.readdir(runtimeA)).sort()).toEqual(['memory-service.cjs']);
    expect((await fs.readdir(runtimeB)).sort()).toEqual(['memory-service.cjs']);
    expect(await fs.readdir(repository)).toEqual([]);
  }, 20000);
});
