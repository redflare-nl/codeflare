import { describe, expect, it } from 'vitest';
import {
  REFLECTION_LIMITS, ReflectionInput, applyReflection, boundReflectionInput, buildReflectionMessages, parseReflection,
} from '../src/engine/reflection';

/**
 * Reflection turns episodes into PROPOSALS. The properties under test are the
 * ones that keep it honest: evidence is cited and must exist, existing
 * knowledge is not restated, nothing weakens verification, limits hold, and
 * every rejection is reported with a reason.
 */

const ep = (id: string, kind: 'experiment' | 'failure' = 'experiment', text = `text of ${id}`) =>
  ({ id, kind, title: `title ${id}`, text, domains: ['testing'], confidence: 0.8, updatedAt: 1000 });

const input: ReflectionInput = {
  episodes: [ep('e1'), ep('e2', 'failure'), ep('e3'), ep('e4', 'failure')],
  skills: [
    { name: 'Upload validation', scope: 'project', status: 'validated', summary: 'Validate uploads', whenToUse: 'forms', successfulUses: 2, failedUses: 0 },
    { name: 'Retry on timeout', scope: 'global', status: 'candidate', summary: 'Retry', whenToUse: 'network', successfulUses: 0, failedUses: 1 },
  ],
  constraints: ['- [constraint] Never write test fixtures into the repository root'],
};

const skill = (name: string, extra: Record<string, unknown> = {}) => ({
  name, summary: 'A procedure', whenToUse: 'When it applies', steps: ['do a', 'do b'], checks: ['it worked'], sources: [], domains: ['Testing'], ...extra,
});

const json = (o: unknown) => JSON.stringify(o);

describe('buildReflectionMessages', () => {
  it('gives the model every episode id, the stored skills and the recorded constraints', () => {
    const messages = buildReflectionMessages(input);
    expect(messages.map(m => m.role)).toEqual(['system', 'user']);
    for (const e of input.episodes) { expect(messages[1].content).toContain(`"${e.id}"`); }
    expect(messages[1].content).toContain('Upload validation');
    expect(messages[1].content).toContain('Never write test fixtures');
    expect(messages[0].content).toMatch(/at least 2 DISTINCT episode ids/);
    expect(messages[0].content).toMatch(/Never propose anything that weakens verification/);
  });
});

describe('boundReflectionInput', () => {
  it('keeps the newest episodes and truncates long text', () => {
    const many = Array.from({ length: REFLECTION_LIMITS.episodes + 10 }, (_, i) => ({ ...ep(`e${i}`), updatedAt: i, text: 'x'.repeat(2000) }));
    const bounded = boundReflectionInput({ episodes: many, skills: [], constraints: [] });
    expect(bounded.episodes).toHaveLength(REFLECTION_LIMITS.episodes);
    expect(bounded.episodes[0].id).toBe(`e${REFLECTION_LIMITS.episodes + 9}`); // newest first
    expect(bounded.episodes[0].text.length).toBe(REFLECTION_LIMITS.episodeChars + 1); // + ellipsis
  });
});

describe('parseReflection', () => {
  it('accepts a well-formed proposal and normalises domains', () => {
    const { proposal, rejected } = parseReflection(json({
      candidateSkills: [skill('Fixture isolation')],
      constraints: [{ text: 'Fixtures live under test/fixtures', episodeIds: ['e1', 'e3'] }],
      contradictions: [{ skills: ['Upload validation', 'Retry on timeout'], why: 'one retries, the other rejects' }],
      recurringFailures: [{ pattern: 'timeouts against the mock server', episodeIds: ['e2', 'e4'] }],
    }), input);
    expect(rejected).toEqual([]);
    expect(proposal.candidateSkills[0]).toMatchObject({ name: 'Fixture isolation', domains: ['testing'] });
    expect(proposal.constraints[0].episodeIds).toEqual(['e1', 'e3']);
    expect(proposal.contradictions[0].skills).toEqual(['Upload validation', 'Retry on timeout']);
    expect(proposal.recurringFailures[0].episodeIds).toEqual(['e2', 'e4']);
  });

  it('tolerates reasoning blocks and code fences around the JSON', () => {
    const text = '<think>let me think</think>\n```json\n' + json({ candidateSkills: [], constraints: [], contradictions: [], recurringFailures: [] }) + '\n```';
    expect(parseReflection(text, input).proposal.candidateSkills).toEqual([]);
  });

  it('rejects a constraint that does not cite at least two KNOWN episodes', () => {
    const { proposal, rejected } = parseReflection(json({
      constraints: [
        { text: 'one anecdote', episodeIds: ['e1'] },
        { text: 'made-up evidence', episodeIds: ['nope', 'e1'] },
        { text: 'same episode twice', episodeIds: ['e1', 'e1'] },
        { text: 'no ids at all' },
      ],
    }), input);
    expect(proposal.constraints).toEqual([]);
    expect(rejected).toHaveLength(4);
    expect(rejected[0]).toMatch(/cites 1 known episode\(s\), needs at least 2/);
    expect(rejected[3]).toMatch(/episodeIds missing/);
  });

  it('rejects a candidate skill that restates an existing skill, and duplicates within the proposal', () => {
    const { proposal, rejected } = parseReflection(json({
      candidateSkills: [skill('upload validation'), skill('New thing'), skill('new thing')],
    }), input);
    expect(proposal.candidateSkills.map(s => s.name)).toEqual(['New thing']);
    expect(rejected[0]).toMatch(/already exists/);
    expect(rejected[1]).toMatch(/duplicate/);
  });

  it('rejects anything that would weaken verification or gates', () => {
    const { proposal, rejected } = parseReflection(json({
      candidateSkills: [skill('Fast path', { steps: ['skip the tests when the change is small'] })],
      constraints: [{ text: 'Bypass the verify gate for docs-only changes', episodeIds: ['e1', 'e2'] }],
    }), input);
    expect(proposal.candidateSkills).toEqual([]);
    expect(proposal.constraints).toEqual([]);
    expect(rejected.every(r => /weakening verification/.test(r))).toBe(true);
  });

  it('rejects a constraint that is already recorded', () => {
    const { proposal, rejected } = parseReflection(json({
      constraints: [{ text: 'Never write test fixtures into the repository root', episodeIds: ['e1', 'e2'] }],
    }), input);
    expect(proposal.constraints).toEqual([]);
    expect(rejected[0]).toMatch(/already recorded/);
  });

  it('rejects malformed skills with a reason instead of dropping them silently', () => {
    const { proposal, rejected } = parseReflection(json({
      candidateSkills: [
        skill('../evil'),
        skill('No steps', { steps: [] }),
        skill('No checks', { checks: [] }),
        'not an object',
      ],
    }), input);
    expect(proposal.candidateSkills).toEqual([]);
    expect(rejected).toHaveLength(4);
    expect(rejected[0]).toMatch(/invalid name/);
    expect(rejected[3]).toMatch(/not an object/);
  });

  it('a contradiction must name at least one stored skill', () => {
    const { proposal, rejected } = parseReflection(json({
      contradictions: [{ skills: ['Unknown skill'], why: 'x' }, { skills: ['Retry on timeout'], why: 'conflicts with episode e2' }],
    }), input);
    expect(proposal.contradictions).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('enforces the per-section limits and reports the overflow', () => {
    const { proposal, rejected } = parseReflection(json({
      candidateSkills: Array.from({ length: REFLECTION_LIMITS.candidateSkills + 2 }, (_, i) => skill(`Skill ${i}`)),
    }), input);
    expect(proposal.candidateSkills).toHaveLength(REFLECTION_LIMITS.candidateSkills);
    expect(rejected).toHaveLength(2);
    expect(rejected[0]).toMatch(/over the limit/);
  });

  it('throws on output with no JSON object at all', () => {
    expect(() => parseReflection('I could not find any patterns.', input)).toThrow(/no JSON object/);
    expect(() => parseReflection('[1,2,3]', input)).toThrow();
  });
});

describe('applyReflection', () => {
  it('saves candidates through the sinks and never touches validation', async () => {
    const saved: string[] = []; const facts: string[] = [];
    const outcome = await applyReflection({
      candidateSkills: [skill('A'), skill('B')],
      constraints: [{ text: 'Keep fixtures out of root', episodeIds: ['e1', 'e2'] }],
      contradictions: [{ skills: ['X'], why: 'y' }],
      recurringFailures: [],
    }, {
      saveCandidateSkill: async s => { saved.push(s.name); return `Saved candidate skill "${s.name}"`; },
      rememberConstraint: async t => { facts.push(t); return `Remembered: - [constraint] ${t}`; },
    });
    expect(saved).toEqual(['A', 'B']);
    expect(outcome.skillsSaved).toEqual(['A', 'B']);
    // The evidence count travels with the fact.
    expect(facts).toEqual(['Keep fixtures out of root (observed in 2 experiments)']);
    expect(outcome.constraintsSaved).toEqual(['Keep fixtures out of root']);
    expect(outcome.contradictions).toHaveLength(1);
    expect(outcome.rejected).toEqual([]);
  });

  it('reports a sink rejection per item and continues with the rest', async () => {
    const outcome = await applyReflection({
      candidateSkills: [skill('Bad'), skill('Good')],
      constraints: [{ text: 'Dup', episodeIds: ['e1', 'e2'] }],
      contradictions: [], recurringFailures: [],
    }, {
      saveCandidateSkill: async s => { if (s.name === 'Bad') { throw new Error('Invalid skill'); } return 'ok'; },
      rememberConstraint: async () => 'Already known (a matching fact is stored): "…". Not duplicated.',
    });
    expect(outcome.skillsSaved).toEqual(['Good']);
    expect(outcome.constraintsSaved).toEqual([]);
    expect(outcome.rejected).toEqual([
      'skill "Bad": Invalid skill',
      'constraint "Dup": Already known (a matching fact is stored): "…". Not duplicated.',
    ]);
  });
});
