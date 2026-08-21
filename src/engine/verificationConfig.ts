/**
 * Project verification adapter — .codeflare/verification.json lets a project
 * declare its own verify commands and MEASURABLE metrics with regression
 * thresholds, extending the auto-detected stack checks.
 *
 * Example:
 * {
 *   "verify": ["npm run typecheck", "npm test"],
 *   "metrics": {
 *     "runtimeErrors": { "command": "node scripts/count-errors.js", "direction": "lower", "required": true },
 *     "fps":           { "command": "node scripts/bench-fps.js",   "direction": "higher", "maxRegressionPercent": 5 }
 *   },
 *   "metricTimeoutMs": 60000
 * }
 *
 * A metric command prints a number (the LAST numeric token of its output is
 * the value). Baseline runs are captured before the turn's first mutation;
 * candidate runs after the verify gate; regressions beyond threshold REJECT.
 *
 * Malformed config NEVER silently passes: parsing returns an explicit error
 * and the caller surfaces it instead of pretending the project has no config.
 *
 * Pure module (no vscode imports) so it is unit-testable.
 */

export interface MetricSpec {
  command: string;
  /** 'higher' = bigger is better (fps); 'lower' = smaller is better (errors, ms). */
  direction: 'higher' | 'lower';
  /** Regression beyond this % fails the metric. Default 0 = any regression fails. */
  maxRegressionPercent?: number;
  /** Required metrics must produce a value; a failed run fails the gate. */
  required?: boolean;
}

export interface VerificationConfig {
  verify: string[];
  metrics: Record<string, MetricSpec>;
  metricTimeoutMs: number;
}

export type ParseResult =
  | { ok: true; config: VerificationConfig }
  | { ok: false; error: string };

/** Parse + validate the config text. Fails safely and explicitly. */
export function parseVerificationConfig(text: string): ParseResult {
  let raw: any;
  try { raw = JSON.parse(text); }
  catch (err: any) { return { ok: false, error: `verification.json is not valid JSON: ${err.message}` }; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'verification.json must be a JSON object' };
  }

  const verify: string[] = [];
  const rawVerify = raw.verify ?? raw.test ?? raw.build;
  if (rawVerify !== undefined) {
    const list = Array.isArray(rawVerify) ? rawVerify : [rawVerify];
    for (const v of list) {
      if (typeof v !== 'string' || !v.trim()) {
        return { ok: false, error: '"verify" must be a command string or an array of command strings' };
      }
      verify.push(v.trim());
    }
  }

  const metrics: Record<string, MetricSpec> = {};
  if (raw.metrics !== undefined) {
    if (typeof raw.metrics !== 'object' || raw.metrics === null || Array.isArray(raw.metrics)) {
      return { ok: false, error: '"metrics" must be an object of { name: { command, direction, … } }' };
    }
    for (const [name, spec] of Object.entries<any>(raw.metrics)) {
      if (typeof spec !== 'object' || spec === null) {
        return { ok: false, error: `metric "${name}" must be an object` };
      }
      if (typeof spec.command !== 'string' || !spec.command.trim()) {
        return { ok: false, error: `metric "${name}" needs a "command" string` };
      }
      if (spec.direction !== 'higher' && spec.direction !== 'lower') {
        return { ok: false, error: `metric "${name}" needs "direction": "higher" or "lower"` };
      }
      if (spec.maxRegressionPercent !== undefined &&
          (typeof spec.maxRegressionPercent !== 'number' || spec.maxRegressionPercent < 0)) {
        return { ok: false, error: `metric "${name}": "maxRegressionPercent" must be a non-negative number` };
      }
      metrics[name] = {
        command: spec.command.trim(),
        direction: spec.direction,
        ...(spec.maxRegressionPercent !== undefined ? { maxRegressionPercent: spec.maxRegressionPercent } : {}),
        ...(spec.required !== undefined ? { required: !!spec.required } : {}),
      };
    }
  }

  const metricTimeoutMs =
    typeof raw.metricTimeoutMs === 'number' && raw.metricTimeoutMs > 0
      ? Math.min(300_000, raw.metricTimeoutMs) : 60_000;

  return { ok: true, config: { verify, metrics, metricTimeoutMs } };
}

/** The LAST numeric token in the command's output is the metric value. */
export function parseMetricValue(output: string): number | undefined {
  const matches = String(output || '').match(/-?\d+(?:\.\d+)?/g);
  if (!matches || !matches.length) { return undefined; }
  const v = parseFloat(matches[matches.length - 1]);
  return Number.isFinite(v) ? (v === 0 ? 0 : v) : undefined;   // normalize -0
}

export interface MetricComparison {
  name: string;
  baseline?: number;
  candidate?: number;
  ok: boolean;
  detail: string;
}

/**
 * Compare candidate metric values against the baseline under each spec.
 * Fail-closed: a REQUIRED metric with a missing value fails; an optional one
 * reports NOT MEASURED without failing.
 */
export function compareMetrics(
  specs: Record<string, MetricSpec>,
  baseline: Record<string, number | undefined>,
  candidate: Record<string, number | undefined>
): MetricComparison[] {
  const out: MetricComparison[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    const b = baseline[name];
    const c = candidate[name];
    if (b === undefined || c === undefined) {
      const which = b === undefined && c === undefined ? 'baseline and candidate'
        : b === undefined ? 'baseline' : 'candidate';
      out.push({
        name, baseline: b, candidate: c,
        ok: !spec.required,
        detail: spec.required
          ? `REQUIRED metric could not be measured (${which} run produced no numeric value)`
          : `not measured (${which} run produced no numeric value)`,
      });
      continue;
    }
    const worse = spec.direction === 'higher' ? c < b : c > b;
    if (!worse) {
      out.push({ name, baseline: b, candidate: c, ok: true, detail: `${b} → ${c} (ok)` });
      continue;
    }
    const denom = Math.abs(b) > 1e-9 ? Math.abs(b) : 1;
    const regressionPct = Math.abs(c - b) / denom * 100;
    const allowed = spec.maxRegressionPercent ?? 0;
    const ok = regressionPct <= allowed;
    out.push({
      name, baseline: b, candidate: c, ok,
      detail: `${b} → ${c} (${spec.direction === 'higher' ? '-' : '+'}${regressionPct.toFixed(1)}% ` +
        `regression, allowed ${allowed}%)${ok ? '' : ' — FAIL'}`,
    });
  }
  return out;
}

export function renderMetricComparisons(rows: MetricComparison[]): string {
  return rows.map(r => `  ${r.ok ? '✓' : '✗'} ${r.name}: ${r.detail}`).join('\n');
}
