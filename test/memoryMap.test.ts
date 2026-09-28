import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MemoryService } from '../src/engine/memoryService';
import { buildMemoryMap, experienceStatus, parseFacts, MemoryMapInput, RawEpisode } from '../src/engine/memoryMap';
import type { ScopedSkillRecord } from '../src/engine/scopedKnowledge';

const skill = (over: Partial<ScopedSkillRecord>): ScopedSkillRecord => ({
  name: 'one-button-canvas-game', summary: 'Build a one-button canvas game', whenToUse: 'Single-file mobile games',
  steps: [], checks: [], sources: [], version: 1, status: 'candidate', createdAt: 1, updatedAt: 1, confidence: 0.5,
  successfulUses: 0, failedUses: 0, inconclusiveUses: 0, controlSuccesses: 0, controlFailures: 0,
  sourceMissionIds: [], trials: [], provenance: [], scope: 'project', ...over,
});

// The shape recordExperiment() writes: an experiment plus, when checks failed, a paired failure record.
const episodes: RawEpisode[] = [
  { id: 'experiment:exp-1', kind: 'experiment', title: 'Maak een origineel HTML-spel', updatedAt: 100, source: 'exp-1',
    text: 'Task: Maak een origineel HTML-spel\nOutcome: INCONCLUSIVE.\nAttempts: 2.\nRUNTIME: pass: run: node test_orbit.js → ok\nVISUAL_COMPARISON: fail: verify_visual(menu.png) → MISMATCH' },
  { id: 'failure:exp-1', kind: 'failure', title: 'Observed failure: Maak een origineel HTML-spel', updatedAt: 100, source: 'exp-1',
    text: 'A prior experiment observed failing checks. The root cause and applicability to this task are unproven.\nVISUAL_COMPARISON: verify_visual(menu.png) → VERDICT: MISMATCH' },
  { id: 'experiment:exp-2', kind: 'experiment', title: 'Add a pause button', updatedAt: 200, source: 'exp-2',
    text: 'Task: Add a pause button\nOutcome: ACCEPTED.\nAttempts: 1.\nTEST: pass: npm test → ok' },
];

const input = (over: Partial<MemoryMapInput> = {}): MemoryMapInput => ({
  projectAvailable: true, projectName: 'AgiTest_II',
  skills: [skill({}), skill({ name: 'verify-diff', scope: 'global', status: 'validated', successfulUses: 3, lift: 0.25 }),
    skill({ name: 'gone', status: 'deleted' })],
  landscapes: [{ missionId: 'm1', goal: 'One-button game', acceptanceCriteria: ['tap only', 'loads < 2 s'],
    sources: [{ url: 'https://example.com', note: 'n' }], decisions: ['concept: ORBIT'], unknowns: [], createdAt: 1, updatedAt: 5 }],
  episodes,
  factsText: '# CodeFlare project memory\n<!-- comment -->\n- [rule] Never commit build output\n- [architecture] Webview talks via postMessage\nplain prose line',
  backlog: [{ id: 'b1', title: 'Fix visual mismatch', reason: 'recurring', source: 'recurring-failure', evidence: [], createdAt: 1, status: 'open' }],
  now: 999, ...over,
});

describe('buildMemoryMap', () => {
  it('draws one experience per experiment, with its failure record folded in as failed checks', () => {
    const map = buildMemoryMap(input());
    expect(map.project.experiences.map(e => e.id)).toEqual(['experiment:exp-1', 'experiment:exp-2']);
    expect(map.project.experienceTotal).toBe(2);
    const [first, second] = map.project.experiences;
    expect(first.outcome).toBe('INCONCLUSIVE');
    expect(first.status).toBe('open');
    expect(first.failedChecks).toEqual(['VISUAL_COMPARISON: verify_visual(menu.png) → VERDICT: MISMATCH']);
    expect(first.observations).toHaveLength(2);
    expect(second.status).toBe('ok');
    expect(second.failedChecks).toEqual([]);
  });

  it('splits skills by scope and leaves deleted ones out', () => {
    const map = buildMemoryMap(input());
    expect(map.project.skills.map(s => s.name)).toEqual(['one-button-canvas-game']);
    expect(map.global.skills.map(s => [s.name, s.status, s.successes, s.lift])).toEqual([['verify-diff', 'validated', 3, 0.25]]);
  });

  it('states how each kind of memory reaches the model', () => {
    // These claims are drawn in the UI; they must match the real code paths
    // (setProjectMemory, knowledgeContext, recall eligibility, no landscape reader).
    expect(buildMemoryMap(input()).access).toEqual({
      facts: 'always', validated: 'auto', candidates: 'request',
      experiences: 'request', goals: 'stored', backlog: 'nightshift',
    });
  });

  it('keeps goals, facts and backlog, and reports a project without storage', () => {
    const map = buildMemoryMap(input());
    expect(map.project.goals[0]).toMatchObject({ goal: 'One-button game', acceptanceCriteria: ['tap only', 'loads < 2 s'], decisions: ['concept: ORBIT'], sources: 1 });
    expect(map.project.facts).toEqual([
      { category: 'rule', text: 'Never commit build output' },
      { category: 'architecture', text: 'Webview talks via postMessage' },
    ]);
    expect(map.project.backlog).toEqual([{ title: 'Fix visual mismatch', status: 'open' }]);
    expect(buildMemoryMap(input({ projectAvailable: false, episodes: [], landscapes: [], factsText: '' })).project)
      .toMatchObject({ available: false, experiences: [], goals: [], facts: [] });
  });

  it('bounds what it sends to the webview', () => {
    const many: RawEpisode[] = Array.from({ length: 90 }, (_, i) => ({
      id: `experiment:e${i}`, kind: 'experiment', title: 'x'.repeat(400), updatedAt: i, text: 'Outcome: ACCEPTED.',
    }));
    const map = buildMemoryMap(input({ episodes: many }));
    expect(map.project.experiences).toHaveLength(60);
    expect(map.project.experienceTotal).toBe(90);
    expect(map.project.experiences[59].updatedAt).toBe(89); // newest kept
    expect(map.project.experiences[0].title.length).toBeLessThanOrEqual(160);
  });

  it('reads outcomes and facts defensively', () => {
    expect(experienceStatus('ACCEPTED')).toBe('ok');
    expect(experienceStatus('REJECTED')).toBe('fail');
    expect(experienceStatus('INCONCLUSIVE')).toBe('open');
    expect(parseFacts('')).toEqual([]);
    expect(parseFacts('- no category here')).toEqual([]);
  });
});

describe('MemoryService.map (real stores)', () => {
  let root = '';
  afterEach(async () => {
    if (root && path.basename(root).startsWith('cf-memory-map-')) { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('shows recorded experiments, saved skills and facts from disk', async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'cf-memory-map-'));
    const service = new MemoryService(path.join(root, 'project'), path.join(root, 'global'), undefined,
      { projectFacts: async () => '- [rule] Tests before commit' });
    await service.recordExperiment({
      id: 'exp-9', task: 'Build ORBIT', provider: 'local', model: 'fixture', startedAt: 1, endedAt: 2,
      state: 'INCONCLUSIVE', decision: 'INCONCLUSIVE', attempts: 1, filesChanged: ['orbit.html'],
      evidence: [{ id: 'v1', type: 'VISUAL_COMPARISON', source: 'tool:verify_visual', phase: 'post-edit', ts: 2, result: 'fail', description: 'menu MISMATCH' }],
      gates: {}, outcome: 'completed',
    } as any);
    await service.saveSkill({ name: 'one-button-game', summary: 's', whenToUse: 'w', steps: ['a'], checks: ['b'], sources: ['https://example.com/one-button'] }, 'global');
    const map = await service.map('AgiTest_V');
    expect(map.project).toMatchObject({ available: true, name: 'AgiTest_V', experienceTotal: 1 });
    expect(map.project.experiences[0]).toMatchObject({ title: 'Build ORBIT', outcome: 'INCONCLUSIVE', failedChecks: ['VISUAL_COMPARISON: menu MISMATCH'] });
    expect(map.project.facts).toEqual([{ category: 'rule', text: 'Tests before commit' }]);
    expect(map.global.skills.map(s => [s.name, s.status])).toEqual([['one-button-game', 'candidate']]);
  });
});

describe('media/memoryMap.js layout', () => {
  const window: any = {};
  runInNewContext(readFileSync('media/memoryMap.js', 'utf8'), { window });
  const ui: any = {};
  runInNewContext(readFileSync('media/ui.js', 'utf8'), { window: ui });
  const view = window.CodeFlareMemoryMap.layout(buildMemoryMap(input()));

  it('draws the learning flow: experiences → candidates → validated, per scope', () => {
    expect(view.project.flow.map((c: any) => [c.key, c.count, c.access])).toEqual([
      ['experiences', 2, 'request'], ['candidates', 1, 'request'], ['validated', 0, 'auto'],
    ]);
    expect(view.global.flow.map((c: any) => [c.key, c.count])).toEqual([['candidates', 0], ['validated', 1]]);
    expect(view.project.side.map((c: any) => [c.key, c.access])).toEqual([['facts', 'always'], ['goals', 'stored'], ['backlog', 'nightshift']]);
  });

  it('summarises what the agent sees in tiles', () => {
    expect(view.tiles.map((t: any) => [t.label, t.value])).toEqual([
      ['Facts in every prompt', 2], ['Validated skills', 1], ['Experiences', 2], ['Candidate skills', 1],
    ]);
  });

  it('keeps an inconclusive experiment inconclusive, marking its failed checks separately', () => {
    const [first] = view.project.flow[0].items;
    expect(first).toMatchObject({ status: 'open', failedChecks: 1, badge: 'INCONCLUSIVE' });
  });

  it('has a Dutch, French and German label for every fixed string it draws', () => {
    const strings = new Set<string>(['Memory map', 'Refresh', 'This project', 'Agent memory', 'shared by all projects',
      'stays in this workspace', 'How each part reaches the agent', 'Select an item to see what is stored.']);
    view.tiles.forEach((t: any) => strings.add(t.label));
    [...view.project.flow, ...view.project.side, ...view.global.flow].forEach((c: any) => { strings.add(c.title); strings.add(c.empty); });
    view.project.arrows.forEach((a: string) => strings.add(a));
    Object.values(window.CodeFlareMemoryMap.access).forEach((a: any) => { strings.add(a.label); strings.add(a.hint); });
    for (const s of strings) {
      for (const lang of ['nl', 'fr', 'de']) {
        const out = ui.CodeFlareUI.translate(s, lang);
        if (s !== 'Backlog') { expect(out, `${s} → ${lang}`).not.toBe(s); }
      }
    }
  });
});
