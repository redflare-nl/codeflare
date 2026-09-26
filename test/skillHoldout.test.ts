import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { CONTROL_MIN_DECISIVE, KnowledgeStore, SkillInput, trialStats } from '../src/engine/missionKnowledge';
import { EvidenceItem } from '../src/engine/evidence';

/**
 * Causal skill validation. "The mission passed while the skill was recalled" is
 * correlation; the control arm — missions where an eligible skill was withheld —
 * is what turns it into evidence that the skill helped. A skill that does no
 * better than its absence cannot stay 'validated', however often it "worked".
 */

const input: SkillInput = { name: 'Retry with backoff', summary: 'Retry transient failures', whenToUse: 'flaky upstreams',
  steps: ['wrap the call'], checks: ['the flaky test passes 10/10'], sources: [] };
let directory: string;
let store: KnowledgeStore;
let now: number;
const proof = (result: 'pass' | 'fail' = 'pass'): EvidenceItem[] => [{ id: `run-${now}`, type: 'TEST', source: 'gate:auto-test',
  ts: now, phase: 'post-edit', description: 'flaky upstream test', result }];

beforeEach(async () => {
  now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  directory = await fs.mkdtemp(join(tmpdir(), 'cf-holdout-'));
  store = new KnowledgeStore(join(directory, 'project'));
  await store.saveSkill(input);
});
afterEach(async () => {
  vi.restoreAllMocks();
  const target = resolve(directory);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.split(sep).at(-1)?.startsWith('cf-holdout-')) { throw new Error('Unsafe test cleanup'); }
  await fs.rm(target, { recursive: true, force: true });
});

async function treated(mission: string, outcome: 'success' | 'failure') { now++; await store.recordSkillOutcome(input.name, mission, outcome, proof(outcome === 'success' ? 'pass' : 'fail'), 1); }
async function control(mission: string, outcome: 'success' | 'failure') { now++; await store.recordSkillOutcome(input.name, mission, outcome, proof(outcome === 'success' ? 'pass' : 'fail'), 1, undefined, true); }
// KnowledgeStore has no getSkill (that lives on the scoped store); read through list().
const skill = async () => (await store.list()).skills.find(s => s.name === input.name)!;

describe('control trials', () => {
  it('a control success never validates the skill and never counts as a use', async () => {
    const message = await (async () => { now++; return store.recordSkillOutcome(input.name, 'ctrl-1', 'success', proof(), 1, undefined, true); })();
    expect(message).toMatch(/^Recorded CONTROL success/);
    const s = await skill();
    expect(s.status).toBe('candidate');
    expect(s.validation).toBeUndefined();
    expect(s).toMatchObject({ successfulUses: 0, failedUses: 0, controlSuccesses: 1, controlFailures: 0 });
    expect(s.lift).toBeUndefined();
  });

  it('a control failure does not put the skill in cooldown', async () => {
    await treated('m1', 'success');
    await control('ctrl-1', 'failure');
    expect((await skill()).cooldownUntil).toBeUndefined();
    expect((await skill()).status).toBe('validated');
  });

  it('a treated and a control trial from the same mission id are distinct records', async () => {
    await treated('m1', 'success');
    await control('m1', 'failure');
    expect((await skill()).trials).toHaveLength(2);
  });

  it('lift appears only once the control arm has enough decisive outcomes', async () => {
    await treated('m1', 'success'); await treated('m2', 'success');
    await control('c1', 'failure'); await control('c2', 'failure');
    expect((await skill()).lift).toBeUndefined();
    expect((await skill()).status).toBe('validated');
    await control('c3', 'failure');
    const s = await skill();
    expect(s.controlFailures).toBe(CONTROL_MIN_DECISIVE);
    expect(s.lift).toBe(1); // 100% with, 0% without
    expect(s.status).toBe('validated');
  });

  it('a skill that does no better than its absence cannot be validated, however many missions passed with it', async () => {
    for (let i = 0; i < 4; i++) { await treated(`m${i}`, 'success'); }
    expect((await skill()).status).toBe('validated');
    for (let i = 0; i < 3; i++) { await control(`c${i}`, 'success'); }
    const s = await skill();
    expect(s.successfulUses).toBe(4);
    expect(s.lift).toBe(0);
    expect(s.status).toBe('candidate');
    // The record says why, in the same message the controller shows.
    now++;
    expect(await store.recordSkillOutcome(input.name, 'm9', 'success', proof(), 1)).toMatch(/lift vs\. control \+0.*|lift vs\. control 0/);
  });

  it('survives a reload with control flags intact', async () => {
    await treated('m1', 'success'); await control('c1', 'failure');
    const reopened = (await new KnowledgeStore(join(directory, 'project')).list()).skills.find(s => s.name === input.name)!;
    expect(reopened.trials.map(t => !!t.control)).toEqual([false, true]);
    expect(reopened.controlFailures).toBe(1);
  });
});

describe('trialStats', () => {
  const t = (outcome: 'success' | 'failure' | 'inconclusive', control = false) =>
    ({ missionId: 'x', skillVersion: 1, outcome, recordedAt: 1, evidence: [], ...(control ? { control: true } : {}) });

  it('computes lift as treated rate minus control rate, rounded', () => {
    const stats = trialStats([t('success'), t('success'), t('failure'), t('success', true), t('failure', true), t('failure', true)]);
    expect(stats).toEqual({ controlSuccesses: 1, controlFailures: 2, controlDecisive: 3, lift: 0.333 });
  });

  it('ignores inconclusive trials on both arms and withholds lift below the minimum', () => {
    expect(trialStats([t('success'), t('inconclusive', true), t('failure', true)]).lift).toBeUndefined();
    expect(trialStats([t('success'), t('inconclusive', true), t('failure', true), t('failure', true), t('failure', true)]).lift).toBe(1);
  });
});
