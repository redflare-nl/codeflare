import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { buildSystemPrompt, classifyProblem, setProblemShape } from '../src/llm/prompts';

// The brief that produced the same game ("ORBIT") twice in two fresh projects.
const GAME_BRIEF = readFileSync(`${__dirname}/fixtures/one-button-game-brief.txt`, 'utf8');

describe('create approach block', () => {
  afterEach(() => setProblemShape(null));

  it('classifies the real one-button game brief as an invention task', () => {
    expect(classifyProblem(GAME_BRIEF)).toBe('create');
  });

  it('asks for a concept shortlist, an originality check and a recorded choice', () => {
    setProblemShape('create');
    const p = buildSystemPrompt({ openFiles: [] });
    expect(p).toMatch(/at least 5 genuinely different concepts/);
    expect(p).toMatch(/first idea is the most probable/);
    expect(p).toMatch(/web_search whether it already exists/);
    expect(p).toMatch(/record_landscape/);
  });

  it('injects nothing without a shape', () => {
    setProblemShape(null);
    expect(buildSystemPrompt({ openFiles: [] })).not.toMatch(/HOW TO APPROACH THIS/);
  });
});
