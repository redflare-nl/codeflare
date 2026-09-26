/**
 * Calibration: closing the loop between what a model CLAIMS and what
 * verification DEMONSTRATED.
 *
 * metrics.jsonl already records both per turn (`outcome` = what the loop
 * reported, `verified` = what a real check showed). Until now that gap was only
 * reported. Here it feeds back: a model with a measured habit of "done" without
 * a demonstrating check gets (1) told its own numbers in the prompt and (2) a
 * stricter requirement review — a behavioural check becomes mandatory for
 * every turn, not only when the user asked for one.
 *
 * Pure and deliberately conservative: a thin sample says nothing, and the
 * adjustment is the same deterministic backstop the review already has.
 */

export interface CalibrationRecord {
  model?: string;
  outcome?: string;
  verified?: 'clean' | 'failed' | 'not-run' | string;
  ts?: string;
}

export interface Calibration {
  model: string;
  /** Turns considered (most recent first, capped at `window`). */
  turns: number;
  /** Turns the loop reported as completed. */
  claimedDone: number;
  /** Of those, turns where a real check settled green. */
  demonstrated: number;
  /** Of those, turns with no demonstrating check at all. */
  unverified: number;
  /** Of those, turns whose last check still failed. */
  failed: number;
  /** (claimedDone − demonstrated) / claimedDone; 0 when nothing was claimed. */
  overclaimRate: number;
  sample: 'none' | 'thin' | 'ok';
}

export interface CalibrationPolicy {
  /** Treat every turn as if the user asked for behavioural verification. */
  requireBehavioralEvidence: boolean;
  /** Prompt text with the model's own numbers, or '' when there is nothing to say. */
  note: string;
}

export const CALIBRATION = {
  window: 30,
  /** Fewer claimed-done turns than this: no conclusion, no adjustment. */
  minClaimed: 8,
  /** Over-claim rate at or above which the stricter review applies. */
  strictAt: 0.4,
  /** Rate below which the model earns an explicit "your record is good" note. */
  reliableBelow: 0.15,
} as const;

/** Most recent `window` turns of `model`, oldest last in the input is fine — order is not assumed. */
export function computeCalibration(records: CalibrationRecord[], model: string, window = CALIBRATION.window): Calibration {
  const mine = records.filter(r => r && r.model === model);
  // Newest first when timestamps exist; otherwise trust file order (append-only).
  const ordered = mine.every(r => typeof r.ts === 'string')
    ? [...mine].sort((a, b) => Date.parse(b.ts!) - Date.parse(a.ts!))
    : [...mine].reverse();
  const recent = ordered.slice(0, window);
  const claimed = recent.filter(r => r.outcome === 'completed');
  const demonstrated = claimed.filter(r => r.verified === 'clean').length;
  const failed = claimed.filter(r => r.verified === 'failed').length;
  const unverified = claimed.length - demonstrated - failed;
  const overclaimRate = claimed.length ? (claimed.length - demonstrated) / claimed.length : 0;
  return {
    model, turns: recent.length, claimedDone: claimed.length, demonstrated, unverified, failed,
    overclaimRate: Math.round(overclaimRate * 1000) / 1000,
    sample: claimed.length === 0 ? 'none' : claimed.length < CALIBRATION.minClaimed ? 'thin' : 'ok',
  };
}

/** What to do about it. Only an adequate sample changes behaviour. */
export function calibrationPolicy(cal: Calibration): CalibrationPolicy {
  if (cal.sample !== 'ok') { return { requireBehavioralEvidence: false, note: '' }; }
  const pct = Math.round(cal.overclaimRate * 100);
  if (cal.overclaimRate >= CALIBRATION.strictAt) {
    return {
      requireBehavioralEvidence: true,
      note:
        `CALIBRATION (measured, this workspace): in your last ${cal.claimedDone} turns reported as done, a real check ` +
        `demonstrated the result in only ${cal.demonstrated} (${pct}% claimed without demonstration: ${cal.unverified} never ` +
        `verified, ${cal.failed} still failing). For THIS turn a behavioural check is therefore mandatory: run the code, ` +
        `test or screenshot that exercises the change before reporting done. "Done" without it will be marked UNVERIFIED.`,
    };
  }
  if (cal.overclaimRate < CALIBRATION.reliableBelow) {
    return {
      requireBehavioralEvidence: false,
      note:
        `CALIBRATION (measured, this workspace): ${cal.demonstrated} of your last ${cal.claimedDone} turns reported as done ` +
        `were demonstrated by a real check. Keep verifying at that standard.`,
    };
  }
  return {
    requireBehavioralEvidence: false,
    note:
      `CALIBRATION (measured, this workspace): ${cal.demonstrated} of your last ${cal.claimedDone} turns reported as done ` +
      `were demonstrated by a real check (${pct}% were not). Run the check that proves the change before reporting done.`,
  };
}
