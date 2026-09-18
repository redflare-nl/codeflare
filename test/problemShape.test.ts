import { describe, expect, it } from 'vitest';
import { classifyProblem } from '../src/llm/problemShape';

describe('classifyProblem — adaptive reasoning depth', () => {
  // TEST A / TEST I: trivial or already-fine requests get NO reasoning block.
  describe('stays silent on trivial / simple requests', () => {
    for (const req of [
      'Rename this variable to userCount',
      'Fix the typo in the header comment',
      'Add an import for lodash',
      'Format this file',
      'Change the button label to "Save"',
      'Add a docstring to this function',
      'What does this function do?',
      'Bump the version to 1.2.0',
    ]) {
      it(`→ null: "${req}"`, () => {
        expect(classifyProblem(req)).toBeNull();
      });
    }
  });

  // TEST C / F / G: ambiguous or failing behaviour → hypothesis-driven debugging.
  describe('detects debugging', () => {
    for (const req of [
      'This game starts stuttering after 20 minutes',        // also perf-ish; perf wins (see below)
      'The login button does not work anymore',
      'Why does the total come out wrong for empty carts?',
      'App crashes on startup with a null reference',
      'The test is flaky and fails intermittently',
      'There is a regression: saving no longer persists',
      'Users report the page hangs when they click export',
    ]) {
      it(`classifies: "${req}"`, () => {
        expect(classifyProblem(req)).toBe(req.includes('stuttering') ? 'perf' : 'debug');
      });
    }
  });

  // TEST D: performance work → measure/baseline discipline.
  describe('detects performance', () => {
    for (const req of [
      'This operation is too slow, make it faster',
      'Optimize the render loop',
      'The endpoint has high latency under load',
      'Reduce memory usage in the parser',
      'Find the bottleneck in the import pipeline',
      'The animation stutters at 30 fps',
    ]) {
      it(`→ perf: "${req}"`, () => {
        expect(classifyProblem(req)).toBe('perf');
      });
    }
  });

  // TEST B: algorithmic / puzzle → reasoning, invariants, counterexamples.
  describe('detects algorithmic puzzles', () => {
    for (const req of [
      'Implement a function to find the shortest path using Dijkstra',
      'Write a recursive solution and analyze its complexity',
      'Solve this coding puzzle about permutations',
      'Handle all the edge cases in this parser',
      'Use dynamic programming to compute the answer',
    ]) {
      it(`→ puzzle: "${req}"`, () => {
        expect(classifyProblem(req)).toBe('puzzle');
      });
    }
  });

  // TEST H: architecture / substantial change → understand-before-moving.
  describe('detects architecture / refactor', () => {
    for (const req of [
      'Refactor the god object into smaller modules',
      'Redesign the plugin architecture',
      'Extract a service for the payment logic',
      'Migrate this to the new API and weigh the trade-offs',
      'Decouple the renderer from the game state',
    ]) {
      it(`→ reason: "${req}"`, () => {
        expect(classifyProblem(req)).toBe('reason');
      });
    }
  });

  // Ordering guarantee: a perf signal wins over a co-occurring debug signal,
  // because performance work demands the more specific measure-first discipline.
  it('prefers perf over debug when both cues are present', () => {
    expect(classifyProblem('The app is slow and sometimes throws an error')).toBe('perf');
  });

  it('handles empty / whitespace input', () => {
    expect(classifyProblem('')).toBeNull();
    expect(classifyProblem('   ')).toBeNull();
  });
});
