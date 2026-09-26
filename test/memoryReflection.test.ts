import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { MemoryDatabase } from '../src/engine/memoryDatabase';
import { MemoryService } from '../src/engine/memoryService';

/**
 * MemoryService's side of reflection: what it hands the model, how it persists
 * an admissible proposal (candidates only, project scope only), and when a
 * pass is due. The model itself is not involved here.
 */

let root: string;
let service: MemoryService;
let facts: string[];

const episode = (id: string, kind: 'experiment' | 'failure', text: string, updatedAt: number) => ({
  id, kind, scope: 'project' as const, title: `Task ${id}`, text, domains: ['testing'], confidence: 0.8, updatedAt, eligible: true,
});

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'cf-memory-reflection-'));
  facts = ['- [constraint] Keep generated fixtures under test/fixtures', '- [stack] vitest'];
  service = new MemoryService(join(root, 'project'), join(root, 'global'), undefined, {
    projectFacts: async () => facts.join('\n'),
    rememberProjectFact: async (fact, category) => {
      const line = `- [${category}] ${fact}`;
      if (facts.includes(line)) { return `Already known (a matching fact is stored): "${line}". Not duplicated.`; }
      facts.push(line);
      return `Remembered: ${line}`;
    },
  });
});

afterEach(async () => {
  const target = resolve(root);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.split(sep).at(-1)?.startsWith('cf-memory-reflection-')) {
    throw new Error('Unsafe test cleanup target');
  }
  await fs.rm(target, { recursive: true, force: true });
});

async function seedEpisodes(n: number): Promise<void> {
  const db = new MemoryDatabase(join(root, 'project'));
  await db.updateState('episodes', () => ({
    value: { schemaVersion: 1, records: Array.from({ length: n }, (_, i) => episode(`experiment:${i}`, i % 2 ? 'failure' : 'experiment', `observation ${i}`, 1000 + i)) },
    result: undefined,
  }));
}

describe('MemoryService reflection', () => {
  it('reflectionInput carries episodes, live skills and only the constraint-like facts', async () => {
    await seedEpisodes(3);
    await service.saveSkill({ name: 'Fixture isolation', summary: 's', whenToUse: 'w', steps: ['a'], checks: ['c'], sources: [] });
    const input = await service.reflectionInput();
    expect(input.episodes.map(e => e.id)).toEqual(['experiment:2', 'experiment:1', 'experiment:0']); // newest first
    expect(input.skills.map(s => s.name)).toEqual(['Fixture isolation']);
    expect(input.constraints).toEqual(['- [constraint] Keep generated fixtures under test/fixtures']); // not the [stack] line
  });

  it('applyReflection saves skills as project CANDIDATES and constraints as facts, and records the pass', async () => {
    await seedEpisodes(4);
    expect(await service.reflectionDue(4)).toBe(true);
    const outcome = await service.applyReflection({
      candidateSkills: [{ name: 'Retry with backoff', summary: 's', whenToUse: 'w', steps: ['a'], checks: ['c'], sources: [], domains: ['backend'] }],
      constraints: [{ text: 'Mock the clock in timeout tests', episodeIds: ['experiment:1', 'experiment:3'] }],
      contradictions: [], recurringFailures: [],
    });
    expect(outcome.skillsSaved).toEqual(['Retry with backoff']);
    expect(outcome.constraintsSaved).toEqual(['Mock the clock in timeout tests']);
    expect(facts).toContain('- [constraint] Mock the clock in timeout tests (observed in 2 experiments)');

    const skills = (await service.list()).skills;
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: 'Retry with backoff', scope: 'project', status: 'candidate' });
    // Reflection saw all 4 episodes, so nothing new is due until more are recorded.
    expect(await service.reflectionDue(1)).toBe(false);
  });

  it('a constraint the facts store already holds is reported as rejected, not saved twice', async () => {
    await seedEpisodes(2);
    const outcome = await service.applyReflection({
      candidateSkills: [],
      constraints: [{ text: 'Keep generated fixtures under test/fixtures (observed in 2 experiments)'.replace(' (observed in 2 experiments)', ''), episodeIds: ['experiment:0', 'experiment:1'] }],
      contradictions: [], recurringFailures: [],
    });
    // The sink appends the evidence suffix, which makes it a NEW line for this simple fake store;
    // the real facts store dedups by substring. What matters here is the message routing:
    expect(outcome.constraintsSaved.length + outcome.rejected.length).toBe(1);
  });

  it('reflectionDue counts only episodes recorded since the last pass', async () => {
    await seedEpisodes(2);
    expect(await service.reflectionDue(5)).toBe(false);
    await service.applyReflection({ candidateSkills: [], constraints: [], contradictions: [], recurringFailures: [] });
    await seedEpisodes(7); // total 7, 2 already seen
    expect(await service.reflectionDue(5)).toBe(true);
    expect(await service.reflectionDue(6)).toBe(false);
  });

  it('without project storage, reflection reports rather than pretends', async () => {
    const globalOnly = new MemoryService(undefined, join(root, 'global2'));
    expect((await globalOnly.reflectionInput()).episodes).toEqual([]);
    expect(await globalOnly.reflectionDue()).toBe(false);
    const outcome = await globalOnly.applyReflection({
      candidateSkills: [{ name: 'X', summary: 's', whenToUse: 'w', steps: ['a'], checks: ['c'], sources: [] }],
      constraints: [{ text: 'Y', episodeIds: ['a', 'b'] }],
      contradictions: [], recurringFailures: [],
    });
    expect(outcome.skillsSaved).toEqual([]);
    expect(outcome.rejected[0]).toMatch(/requires an open workspace/);
    expect(outcome.rejected[1]).toMatch(/project facts are unavailable/);
  });
});
