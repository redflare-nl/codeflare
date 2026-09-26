/**
 * The backlog: goals the system sets ITSELF, derived from evidence rather than
 * from a prompt. A recurring failure that reflection surfaced, a contradiction
 * between two stored skills, a mission that ended REJECTED or NEEDS_REVIEW —
 * each is a concrete, evidence-cited thing worth a bounded autonomous mission.
 *
 * "Night Shift" (in the provider) works this backlog one item at a time, as an
 * autonomous mission with the ordinary gates, guardrails and mission budget.
 * The human still presses the button; what the system chooses to do when
 * pressed is its own. Pure: derivation and prompt text only.
 */

export type BacklogSource = 'recurring-failure' | 'contradiction' | 'unfinished-mission' | 'user';
export type BacklogStatus = 'open' | 'running' | 'done' | 'failed' | 'skipped';

export interface BacklogItem {
  id: string;
  title: string;
  /** Why this is worth doing, in one or two sentences. */
  reason: string;
  source: BacklogSource;
  /** Episode / mission ids that justify it. */
  evidence: string[];
  createdAt: number;
  status: BacklogStatus;
  /** Mission that worked on it, once one did. */
  missionId?: string;
  /** Short note on how it ended. */
  outcome?: string;
}

export interface BacklogState { schemaVersion: 1; items: BacklogItem[]; }

export interface BacklogDerivationInput {
  recurringFailures: Array<{ pattern: string; episodeIds: string[] }>;
  contradictions: Array<{ skills: string[]; why: string }>;
  /** Episodes as reflection sees them; the text carries "Outcome: <decision>". */
  episodes: Array<{ id: string; kind: string; title: string; text: string; updatedAt: number | string }>;
  existing: BacklogItem[];
  now?: number;
}

export const BACKLOG_LIMITS = { items: 40, perDerivation: 6, unfinishedLookback: 25 } as const;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const sameGoal = (a: string, b: string) => {
  const x = norm(a), y = norm(b);
  return x === y || (x.length >= 20 && y.includes(x)) || (y.length >= 20 && x.includes(y));
};

export function emptyBacklog(): BacklogState { return { schemaVersion: 1, items: [] }; }

/** Persisted state → validated, anything malformed dropped rather than trusted. */
export function coerceBacklog(raw: unknown): BacklogState {
  const state = emptyBacklog();
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as BacklogState).items)) { return state; }
  for (const item of (raw as BacklogState).items) {
    if (typeof item !== 'object' || item === null) { continue; }
    const i = item as BacklogItem;
    if (typeof i.id !== 'string' || !i.id || typeof i.title !== 'string' || !i.title
      || !['recurring-failure', 'contradiction', 'unfinished-mission', 'user'].includes(i.source)
      || !['open', 'running', 'done', 'failed', 'skipped'].includes(i.status)
      || !Array.isArray(i.evidence) || !i.evidence.every(e => typeof e === 'string')
      || typeof i.createdAt !== 'number') { continue; }
    state.items.push({
      id: i.id, title: i.title.slice(0, 200), reason: typeof i.reason === 'string' ? i.reason.slice(0, 800) : '',
      source: i.source, evidence: i.evidence.slice(0, 20), createdAt: i.createdAt,
      // A reload never leaves an item "running": no process is working on it now.
      status: i.status === 'running' ? 'open' : i.status,
      ...(typeof i.missionId === 'string' ? { missionId: i.missionId } : {}),
      ...(typeof i.outcome === 'string' ? { outcome: i.outcome.slice(0, 400) } : {}),
    });
  }
  state.items = state.items.slice(-BACKLOG_LIMITS.items);
  return state;
}

/**
 * New goals implied by the evidence, deduplicated against what is already on
 * the backlog (any status — a goal that was done or skipped is not re-added
 * from the same evidence).
 */
export function deriveBacklog(input: BacklogDerivationInput): BacklogItem[] {
  const now = input.now ?? Date.now();
  const out: BacklogItem[] = [];
  const known = [...input.existing];
  const add = (item: Omit<BacklogItem, 'id' | 'createdAt' | 'status'>) => {
    if (out.length >= BACKLOG_LIMITS.perDerivation) { return; }
    if (known.some(k => sameGoal(k.title, item.title) || (k.source === item.source && item.evidence.length && item.evidence.every(e => k.evidence.includes(e))))) { return; }
    const created: BacklogItem = { ...item, id: `goal-${now}-${out.length + 1}`, createdAt: now, status: 'open' };
    out.push(created); known.push(created);
  };

  for (const f of input.recurringFailures) {
    if (f.episodeIds.length < 2) { continue; }
    add({
      title: `Investigate recurring failure: ${f.pattern.slice(0, 140)}`,
      reason: `Reflection found the same failure pattern in ${f.episodeIds.length} recorded experiments. Find the common cause and fix it, or record why it cannot be fixed.`,
      source: 'recurring-failure', evidence: f.episodeIds.slice(0, 20),
    });
  }
  for (const c of input.contradictions) {
    if (!c.skills.length) { continue; }
    add({
      title: `Resolve contradiction between skills: ${c.skills.join(' vs ')}`.slice(0, 200),
      reason: `${c.why.slice(0, 400)} Determine which applies when, revise or delete the wrong one with evidence.`,
      source: 'contradiction', evidence: c.skills.map(s => `skill:${s}`),
    });
  }
  const ts = (e: BacklogDerivationInput['episodes'][number]) => typeof e.updatedAt === 'number' ? e.updatedAt : Date.parse(String(e.updatedAt)) || 0;
  const unfinished = [...input.episodes]
    .filter(e => e.kind === 'experiment' && /Outcome:\s*(REJECTED|NEEDS_REVIEW)/i.test(e.text))
    .sort((a, b) => ts(b) - ts(a))
    .slice(0, BACKLOG_LIMITS.unfinishedLookback);
  for (const e of unfinished) {
    const decision = (e.text.match(/Outcome:\s*(REJECTED|NEEDS_REVIEW)/i) || [])[1]?.toUpperCase() ?? 'NEEDS_REVIEW';
    add({
      title: `Finish unaccepted work: ${e.title.slice(0, 150)}`,
      reason: `A previous mission ended ${decision}. Re-establish what was asked, check the current state of the code, and bring it to accepted with evidence — or record why it should be abandoned.`,
      source: 'unfinished-mission', evidence: [e.id],
    });
  }
  return out;
}

/** Oldest open item first: goals are worked in the order the evidence appeared. */
export function nextOpenItem(state: BacklogState): BacklogItem | undefined {
  return [...state.items].filter(i => i.status === 'open').sort((a, b) => a.createdAt - b.createdAt)[0];
}

/** The mission text for one goal. Bounded, evidence-cited, and told when to stop. */
export function goalPrompt(item: BacklogItem): string {
  return [
    `NIGHT SHIFT GOAL (self-selected from recorded evidence; source: ${item.source}).`,
    `Goal: ${item.title}`,
    `Why: ${item.reason}`,
    item.evidence.length ? `Evidence ids: ${item.evidence.join(', ')} — use recall_memory / read_memory_artifact to read them first.` : '',
    '',
    'Procedure:',
    '1. Define observable acceptance criteria for this goal BEFORE changing anything (record_landscape).',
    '2. Reproduce the problem or re-establish the current state with a real run/test. If it cannot be reproduced, report that as the finding and STOP — do not invent work.',
    '3. Make the smallest change that resolves it, with a regression test where the project has tests.',
    '4. Verify with the project\'s own checks. Report what was demonstrated separately from what you believe.',
    'Existing permissions, budgets and guardrails apply unchanged. Do not publish, deploy, install or reach outside this workspace.',
  ].filter(Boolean).join('\n');
}

/** Human-readable listing for a notice. */
export function describeBacklog(state: BacklogState): string {
  if (!state.items.length) { return 'Backlog is empty — reflection has not surfaced any goals yet.'; }
  const mark: Record<BacklogStatus, string> = { open: '○', running: '▶', done: '✓', failed: '✗', skipped: '–' };
  return state.items.map(i => `${mark[i.status]} [${i.source}] ${i.title}${i.outcome ? ` — ${i.outcome}` : ''}`).join('\n');
}
