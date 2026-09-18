/**
 * The Experiment record — one controlled engineering attempt, aggregating what
 * the turn machinery already produces (request, mutations, gate outcomes,
 * evidence) into a single persistable, reviewable unit with a fail-closed
 * acceptance decision.
 *
 * The record ANNOTATES the agent loop; it does not drive it. States are the
 * subset the loop can genuinely distinguish today — more (CHALLENGING,
 * ESCALATED, …) get added when the features that produce them land.
 *
 * Pure module (no vscode imports) so it is unit-testable.
 */

import { EvidenceItem, isBehavioral, verificationSummary } from './evidence';

export type ExperimentState =
  | 'CREATED'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'INCONCLUSIVE'
  | 'NEEDS_REVIEW'
  | 'ABORTED';

export type Decision = 'ACCEPTED' | 'REJECTED' | 'INCONCLUSIVE' | 'NEEDS_REVIEW';

/** What each gate demonstrated. 'not-run' is meaningful — it stays visible. */
export interface GateOutcomes {
  imageQc?: 'clean' | 'failed';
  meshQc?: 'clean' | 'failed';
  diagnostics?: 'clean' | 'failed' | 'not-run';
  verify?: 'clean' | 'failed' | 'skipped' | 'not-run';
  diffReview?: 'ok' | 'issues' | 'not-run';
}

export interface ExperimentRecord {
  id: string;
  /** The user's request (truncated) — what this experiment tried to achieve. */
  task: string;
  model: string;
  provider: string;
  state: ExperimentState;
  startedAt: number;
  endedAt?: number;
  /** Automated fix rounds actually used (0 = clean first pass). */
  attempts: number;
  filesChanged: string[];
  evidence: EvidenceItem[];
  gates: GateOutcomes;
  decision?: Decision;
  decisionReasons?: string[];
  /** What the loop reported: completed/stopped/error/incomplete. */
  outcome?: string;
  /** Git isolation, when the experiment ran on its own branch. */
  isolation?: { branch: string; baseBranch: string; baseCommit: string; outcome?: string };
}

let experimentSeq = 0;

export function newExperiment(task: string, model: string, provider: string): ExperimentRecord {
  return {
    id: `exp-${Date.now()}-${++experimentSeq}`,
    task: String(task || '').slice(0, 500),
    model, provider,
    state: 'CREATED',
    startedAt: Date.now(),
    attempts: 0,
    filesChanged: [],
    evidence: [],
    gates: {},
  };
}

export interface DecisionInput {
  gates: GateOutcomes;
  evidence: EvidenceItem[];
  filesChanged: number;
  /** The loop's outcome: completed/stopped/error/incomplete. */
  outcome: string;
  /** The request explicitly demanded behavioural verification. */
  behaviorRequired: boolean;
}

/**
 * The fail-closed acceptance decision.
 *
 * Hard rules, in order:
 *  - a turn that did not finish cannot be accepted;
 *  - no changes → nothing to accept (INCONCLUSIVE, which is a fine outcome);
 *  - any failed gate → REJECTED (a green build alone never outvotes a red one);
 *  - unmet/unverified requirements → NEEDS_REVIEW;
 *  - nothing verified at all → NEEDS_REVIEW, never ACCEPTED;
 *  - demanded-but-missing behavioural evidence → NEEDS_REVIEW;
 *  - otherwise ACCEPTED — with an honest note when acceptance rests on static
 *    checks only.
 */
export function decideAcceptance(input: DecisionInput): { decision: Decision; reasons: string[] } {
  const { gates, evidence, filesChanged, outcome, behaviorRequired } = input;
  const reasons: string[] = [];

  if (outcome === 'stopped' || outcome === 'error') {
    return { decision: 'INCONCLUSIVE', reasons: [`turn ended early (${outcome}) — nothing was decided`] };
  }
  if (filesChanged === 0) {
    return { decision: 'INCONCLUSIVE', reasons: ['no files changed — nothing to accept or reject'] };
  }

  if (gates.diagnostics === 'failed') { reasons.push('diagnostics still report new errors'); }
  if (gates.verify === 'failed') { reasons.push('the verify command still fails'); }
  if (gates.imageQc === 'failed') { reasons.push('generated images still look broken'); }
  if (reasons.length) { return { decision: 'REJECTED', reasons }; }

  const behavioralFails = evidence.filter(i => isBehavioral(i) && i.result === 'fail');
  if (behavioralFails.length) {
    return {
      decision: 'REJECTED',
      reasons: behavioralFails.map(i => `behavioural check failed: ${i.description.slice(0, 120)}`),
    };
  }

  if (gates.diffReview === 'issues') {
    return { decision: 'NEEDS_REVIEW', reasons: ['the self-review left requirements unmet or unverified'] };
  }

  const anyCheckRan =
    gates.diagnostics === 'clean' || gates.verify === 'clean' ||
    evidence.some(i => i.result === 'pass');
  if (!anyCheckRan) {
    return { decision: 'NEEDS_REVIEW', reasons: ['no check demonstrated anything — nothing was verified'] };
  }

  const summary = verificationSummary(evidence);
  if (behaviorRequired && summary.behavioral === 0) {
    return {
      decision: 'NEEDS_REVIEW',
      reasons: ['behavioural verification was requested but no behavioural evidence exists'],
    };
  }

  if (summary.behavioral === 0) {
    reasons.push('accepted on static checks only — behaviour was not exercised');
  }
  return { decision: 'ACCEPTED', reasons };
}

/** Map a decision onto the record's terminal state. */
export function stateForDecision(d: Decision): ExperimentState {
  switch (d) {
    case 'ACCEPTED': return 'ACCEPTED';
    case 'REJECTED': return 'REJECTED';
    case 'NEEDS_REVIEW': return 'NEEDS_REVIEW';
    default: return 'INCONCLUSIVE';
  }
}
