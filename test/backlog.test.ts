import { describe, expect, it } from 'vitest';
import { BACKLOG_LIMITS, coerceBacklog, deriveBacklog, describeBacklog, emptyBacklog, goalPrompt, nextOpenItem } from '../src/engine/backlog';

/**
 * Goals come from evidence and never twice from the same evidence; a reload
 * never resurrects a "running" item; the prompt tells the mission when to stop.
 */

const ep = (id: string, decision: string, at: number, kind = 'experiment') =>
  ({ id, kind, title: `Task ${id}`, text: `Task: Task ${id}\nOutcome: ${decision}.\nAttempts: 1.`, updatedAt: at });

describe('deriveBacklog', () => {
  it('turns recurring failures, contradictions and unaccepted missions into goals', () => {
    const items = deriveBacklog({
      recurringFailures: [{ pattern: 'timeouts against the mock server', episodeIds: ['e1', 'e2'] }, { pattern: 'anecdote', episodeIds: ['e3'] }],
      contradictions: [{ skills: ['Retry on timeout', 'Fail fast'], why: 'one retries, the other aborts' }],
      episodes: [ep('m1', 'REJECTED', 10), ep('m2', 'ACCEPTED', 20), ep('m3', 'NEEDS_REVIEW', 30), ep('f1', 'REJECTED', 40, 'failure')],
      existing: [], now: 1000,
    });
    expect(items.map(i => i.source)).toEqual(['recurring-failure', 'contradiction', 'unfinished-mission', 'unfinished-mission']);
    expect(items[0].title).toMatch(/Investigate recurring failure: timeouts/);
    expect(items[0].evidence).toEqual(['e1', 'e2']);
    expect(items[1].title).toBe('Resolve contradiction between skills: Retry on timeout vs Fail fast');
    // Newest unaccepted mission first; accepted ones and failure-kind episodes are not goals.
    expect(items[2].evidence).toEqual(['m3']);
    expect(items[3].evidence).toEqual(['m1']);
    expect(items.every(i => i.status === 'open' && i.createdAt === 1000)).toBe(true);
  });

  it('does not re-add a goal already on the backlog, whatever its status', () => {
    const existing = deriveBacklog({ recurringFailures: [{ pattern: 'flaky clock', episodeIds: ['e1', 'e2'] }], contradictions: [], episodes: [], existing: [], now: 1 });
    existing[0].status = 'done';
    const again = deriveBacklog({ recurringFailures: [{ pattern: 'flaky clock', episodeIds: ['e1', 'e2'] }], contradictions: [], episodes: [ep('m1', 'REJECTED', 5)], existing, now: 2 });
    expect(again.map(i => i.source)).toEqual(['unfinished-mission']);
    // Same evidence under a reworded pattern is still the same goal.
    const reworded = deriveBacklog({ recurringFailures: [{ pattern: 'the clock is flaky in tests', episodeIds: ['e1', 'e2'] }], contradictions: [], episodes: [], existing, now: 3 });
    expect(reworded).toEqual([]);
  });

  it('caps how many goals one derivation may add', () => {
    const episodes = Array.from({ length: 20 }, (_, i) => ep(`m${i}`, 'REJECTED', i));
    expect(deriveBacklog({ recurringFailures: [], contradictions: [], episodes, existing: [] })).toHaveLength(BACKLOG_LIMITS.perDerivation);
  });
});

describe('backlog state', () => {
  it('coerces persisted state, drops junk and never restores a running item as running', () => {
    const state = coerceBacklog({ schemaVersion: 1, items: [
      { id: 'a', title: 'A', reason: 'r', source: 'user', evidence: [], createdAt: 1, status: 'running' },
      { id: 'b', title: 'B', reason: 'r', source: 'bogus', evidence: [], createdAt: 1, status: 'open' },
      'garbage',
      { id: 'c', title: 'C', reason: 'r', source: 'contradiction', evidence: ['skill:X'], createdAt: 2, status: 'done', outcome: 'resolved' },
    ] });
    expect(state.items.map(i => `${i.id}:${i.status}`)).toEqual(['a:open', 'c:done']);
    expect(coerceBacklog(null)).toEqual(emptyBacklog());
  });

  it('picks the oldest open item next', () => {
    const state = coerceBacklog({ schemaVersion: 1, items: [
      { id: 'new', title: 'N', reason: '', source: 'user', evidence: [], createdAt: 5, status: 'open' },
      { id: 'done', title: 'D', reason: '', source: 'user', evidence: [], createdAt: 1, status: 'done' },
      { id: 'old', title: 'O', reason: '', source: 'user', evidence: [], createdAt: 2, status: 'open' },
    ] });
    expect(nextOpenItem(state)?.id).toBe('old');
    expect(nextOpenItem(emptyBacklog())).toBeUndefined();
  });

  it('writes a goal prompt that cites evidence and tells the mission to stop when nothing reproduces', () => {
    const [item] = deriveBacklog({ recurringFailures: [{ pattern: 'x', episodeIds: ['e1', 'e2'] }], contradictions: [], episodes: [], existing: [] });
    const prompt = goalPrompt(item);
    expect(prompt).toMatch(/NIGHT SHIFT GOAL/);
    expect(prompt).toMatch(/Evidence ids: e1, e2/);
    expect(prompt).toMatch(/If it cannot be reproduced, report that as the finding and STOP/);
    expect(prompt).toMatch(/guardrails apply unchanged/);
  });

  it('describes the backlog for a notice', () => {
    expect(describeBacklog(emptyBacklog())).toMatch(/empty/);
    const state = coerceBacklog({ schemaVersion: 1, items: [{ id: 'a', title: 'Fix it', reason: '', source: 'user', evidence: [], createdAt: 1, status: 'failed', outcome: 'could not reproduce' }] });
    expect(describeBacklog(state)).toBe('✗ [user] Fix it — could not reproduce');
  });
});
