/**
 * A bounded, presentation-ready picture of what the agent remembers — the data
 * behind Settings → Memory map. Pure: the MemoryService gathers the raw stores
 * and this shapes them, so what the map CLAIMS about each kind of memory (is it
 * in every prompt? only on request? never read back?) is unit-tested here, next
 * to the code that decides it, instead of living as prose in the webview.
 *
 * How each kind actually reaches the model (verified against the code paths):
 * - facts (memory.md)    → 'always'  : setProjectMemory puts them in every prompt.
 * - validated skills     → 'auto'    : knowledgeContext injects up to 5 that match the request.
 * - candidate skills     → 'request' : only list_skills shows them; recall marks them ineligible.
 * - experiences          → 'request' : only when the agent calls recall_memory.
 * - goals (landscapes)   → 'stored'  : record_landscape writes them; nothing reads them back.
 * - backlog              → 'nightshift' : read by Night Shift to choose its next goal.
 */
import type { BacklogItem } from './backlog';
import type { LandscapeRecord } from './missionKnowledge';
import type { ScopedSkillRecord } from './scopedKnowledge';

export type MemoryAccess = 'always' | 'auto' | 'request' | 'stored' | 'nightshift';
export type MapStatus = 'ok' | 'fail' | 'open';

export interface MapSkill {
  name: string;
  scope: 'project' | 'global';
  status: 'candidate' | 'validated' | 'stale';
  summary: string;
  whenToUse: string;
  version: number;
  successes: number;
  failures: number;
  inconclusive: number;
  /** Success rate with minus without the skill; undefined = no causal evidence yet. */
  lift?: number;
  updatedAt: number;
}

export interface MapExperience {
  id: string;
  title: string;
  /** The controller's decision for the turn (ACCEPTED, INCONCLUSIVE, …). */
  outcome: string;
  status: MapStatus;
  /** Checks that failed in this experiment (from its paired failure record). */
  failedChecks: string[];
  observations: string[];
  updatedAt: number;
}

export interface MapGoal {
  goal: string;
  acceptanceCriteria: string[];
  decisions: string[];
  unknowns: number;
  sources: number;
  updatedAt: number;
}

export interface MapFact { category: string; text: string; }
export interface MapBacklogItem { title: string; status: BacklogItem['status']; }

export interface MemoryMap {
  generatedAt: number;
  project: {
    available: boolean;
    name?: string;
    facts: MapFact[];
    experiences: MapExperience[];
    /** Experiences recorded in total; `experiences` holds only the newest MAX_EXPERIENCES. */
    experienceTotal: number;
    goals: MapGoal[];
    skills: MapSkill[];
    backlog: MapBacklogItem[];
    lastReflectionAt?: number;
  };
  global: { skills: MapSkill[] };
  access: Record<'facts' | 'validated' | 'candidates' | 'experiences' | 'goals' | 'backlog', MemoryAccess>;
}

/** The subset of a stored episode the map reads. */
export interface RawEpisode {
  id: string;
  kind: string;
  title: string;
  text: string;
  source?: string;
  updatedAt: number | string;
}

export interface MemoryMapInput {
  projectAvailable: boolean;
  projectName?: string;
  skills: ScopedSkillRecord[];
  landscapes: LandscapeRecord[];
  episodes: RawEpisode[];
  factsText: string;
  backlog: BacklogItem[];
  lastReflectionAt?: number;
  now?: number;
}

export const MAX_EXPERIENCES = 60;
const clip = (s: unknown, n: number) => {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const time = (v: number | string) => (typeof v === 'number' ? v : Date.parse(v) || 0);

/** "- [category] text" lines of the durable facts file; comments and prose are skipped. */
export function parseFacts(text: string): MapFact[] {
  const out: MapFact[] = [];
  for (const line of (text || '').split('\n')) {
    const m = /^\s*-\s+\[([^\]]{1,40})\]\s+(.+)$/.exec(line);
    if (m) { out.push({ category: m[1].trim().toLowerCase(), text: clip(m[2], 300) }); }
  }
  return out.slice(0, 80);
}

/** The controller's decision from an experiment record ("Outcome: ACCEPTED."). */
export function experienceStatus(outcome: string): MapStatus {
  if (/accept|pass|success|complet/i.test(outcome)) { return 'ok'; }
  if (/reject|fail|error/i.test(outcome)) { return 'fail'; }
  return 'open';
}

function skill(s: ScopedSkillRecord): MapSkill | undefined {
  if (s.status === 'deleted') { return undefined; }
  return {
    name: clip(s.name, 80), scope: s.scope, status: s.status,
    summary: clip(s.summary, 300), whenToUse: clip(s.whenToUse, 300), version: s.version,
    successes: s.successfulUses || 0, failures: s.failedUses || 0, inconclusive: s.inconclusiveUses || 0,
    ...(typeof s.lift === 'number' && Number.isFinite(s.lift) ? { lift: s.lift } : {}),
    updatedAt: s.updatedAt,
  };
}

/**
 * One experience per experiment; its paired failure record ("failure:<id>")
 * becomes the failedChecks of that experience instead of a second node — a turn
 * with failing checks is ONE thing that happened, not two memories.
 */
function experiences(records: RawEpisode[]): MapExperience[] {
  const failures = new Map<string, string[]>();
  for (const r of records) {
    if (r.kind !== 'failure') { continue; }
    const lines = (r.text || '').split('\n').slice(1).map(l => clip(l, 220)).filter(Boolean).slice(0, 8);
    failures.set(r.id.replace(/^failure:/, ''), lines);
  }
  const out: MapExperience[] = [];
  for (const r of records) {
    if (r.kind !== 'experiment') { continue; }
    const key = r.id.replace(/^experiment:/, '');
    const lines = (r.text || '').split('\n');
    const outcome = (/^Outcome:\s*([^.\n]+)/m.exec(r.text || '') || [])[1]?.trim() || 'UNKNOWN';
    const failedChecks = failures.get(key) || [];
    const observations = lines.filter(l => /^[A-Z_]+:\s/.test(l) && !/^(Task|Outcome|Attempts):/.test(l))
      .map(l => clip(l, 220)).slice(0, 8);
    out.push({
      id: r.id, title: clip(r.title, 160), outcome, status: experienceStatus(outcome),
      failedChecks, observations, updatedAt: time(r.updatedAt),
    });
  }
  return out.sort((a, b) => a.updatedAt - b.updatedAt);
}

export function buildMemoryMap(input: MemoryMapInput): MemoryMap {
  const skills = input.skills.map(skill).filter((s): s is MapSkill => !!s)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const all = experiences(input.episodes || []);
  return {
    generatedAt: input.now ?? Date.now(),
    project: {
      available: input.projectAvailable,
      ...(input.projectName ? { name: input.projectName } : {}),
      facts: parseFacts(input.factsText),
      experiences: all.slice(-MAX_EXPERIENCES),
      experienceTotal: all.length,
      goals: (input.landscapes || []).slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20).map(l => ({
        goal: clip(l.goal, 300),
        acceptanceCriteria: (l.acceptanceCriteria || []).slice(0, 12).map(c => clip(c, 200)),
        decisions: (l.decisions || []).slice(0, 8).map(d => clip(d, 200)),
        unknowns: (l.unknowns || []).length, sources: (l.sources || []).length, updatedAt: l.updatedAt,
      })),
      skills: skills.filter(s => s.scope === 'project'),
      backlog: (input.backlog || []).slice(-30).map(b => ({ title: clip(b.title, 160), status: b.status })),
      ...(input.lastReflectionAt ? { lastReflectionAt: input.lastReflectionAt } : {}),
    },
    global: { skills: skills.filter(s => s.scope === 'global') },
    access: {
      facts: 'always', validated: 'auto', candidates: 'request',
      experiences: 'request', goals: 'stored', backlog: 'nightshift',
    },
  };
}
