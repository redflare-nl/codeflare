/**
 * Typed evidence — the first-class record of what a turn actually observed,
 * measured, or tested. The agent loop's gates and behavioural tools produce
 * EvidenceItems; the diff review and the acceptance decision consume them.
 *
 * Design rules:
 *  - Evidence is DATA, not prose. The rendering for the judge prompt is a
 *    projection (renderEvidenceLine), so downstream checks query types and
 *    results instead of regexing strings.
 *  - Missing evidence stays visible: verificationSummary distinguishes
 *    behavioural proof from static checks and never upgrades one to the other.
 *
 * Pure module (no vscode imports) so it is unit-testable.
 */

export type EvidencePhase = 'pre-edit' | 'post-edit';
export type EvidenceResult = 'pass' | 'fail' | 'info' | 'inconclusive';

export type EvidenceType =
  | 'BUILD'
  | 'TEST'
  | 'STATIC_ANALYSIS'
  | 'DIAGNOSTIC'
  | 'RUNTIME'
  | 'PROBE'
  | 'DEBUGGER'
  | 'LOG'
  | 'SCREENSHOT'
  | 'VISUAL_COMPARISON'
  | 'BENCHMARK'
  | 'PROPERTY_TEST'
  | 'DIFFERENTIAL_TEST'
  | 'FUZZ'
  | 'COUNTEREXAMPLE'
  | 'USER_CONFIRMATION';

export interface EvidenceItem {
  id: string;
  type: EvidenceType;
  /** Tool or gate that produced it (e.g. 'run_command', 'gate:diagnostics'). */
  source: string;
  /** Stable identity of a re-runnable check; a later result supersedes its earlier verdict. */
  checkId?: string;
  ts: number;
  /** Order relative to the first file mutation of the turn. */
  phase: EvidencePhase;
  /** Compact human-readable line WITHOUT the phase prefix. */
  description: string;
  result: EvidenceResult;
  /** Machine-readable qualifiers, e.g. 'dependency-install'. */
  tags?: string[];
  /** Paths to artifacts backing this evidence (screenshots, lab output, …). */
  artifactRefs?: string[];
}

let evidenceSeq = 0;

export function makeEvidence(
  type: EvidenceType,
  source: string,
  description: string,
  result: EvidenceResult,
  phase: EvidencePhase,
  extra?: { tags?: string[]; artifactRefs?: string[] }
): EvidenceItem {
  return {
    id: `e${++evidenceSeq}`,
    type, source, description, result, phase,
    ts: Date.now(),
    ...(extra?.tags?.length ? { tags: extra.tags } : {}),
    ...(extra?.artifactRefs?.length ? { artifactRefs: extra.artifactRefs } : {}),
  };
}

/**
 * Behavioural evidence = the code actually RAN and its behaviour was observed.
 * Static checks (build/typecheck/diagnostics) never count as behavioural —
 * this is the boundary that keeps "build passed" from becoming "verified".
 */
export function isBehavioral(item: EvidenceItem): boolean {
  return item.type === 'TEST' || item.type === 'RUNTIME' || item.type === 'VISUAL_COMPARISON' ||
    item.type === 'PROBE' || item.type === 'DEBUGGER' || item.type === 'BENCHMARK' ||
    item.type === 'PROPERTY_TEST' || item.type === 'DIFFERENTIAL_TEST' ||
    item.type === 'FUZZ' || item.type === 'COUNTEREXAMPLE';
}

/** Keep historical evidence for audit, but judge a repeated check by its latest result. */
export function currentEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const latest = new Map<string, EvidenceItem>();
  for (const item of items) { if (item.checkId) { latest.set(item.checkId, item); } }
  return items.filter(item => !item.checkId || latest.get(item.checkId) === item);
}

/** Dependency-install side effect (modifies manifests outside the turn diff). */
const INSTALL_RE =
  /\b(npm|pnpm|yarn)\s+(install|add|i)\b|\bpip3?\s+install\b|\b(cargo\s+add|go\s+get|dotnet\s+add|gem\s+install)\b/i;

/**
 * Classify a tool result into typed evidence. Returns undefined for tools that
 * are not evidence (reads/edits — the turn diff covers edits). Ported from the
 * previous string-based recorder; descriptions are kept compatible with the
 * judge prompt's expectations.
 */
export function classifyToolEvidence(
  name: string,
  rawArgs: string,
  output: string,
  phase: EvidencePhase
): EvidenceItem | undefined {
  const out = String(output || '');
  const args = (() => { try { return JSON.parse(rawArgs || '{}'); } catch { return {}; } })();

  if (name === 'run_command') {
    const cmd = String(args.command || '').replace(/\s+/g, ' ').trim();
    const result: EvidenceResult = /exit code:\s*0\b/i.test(out) ? 'pass'
      : /exit code:\s*[1-9]/i.test(out) ? 'fail'
      : 'info';
    const res = result === 'pass' ? 'ok'
      : result === 'fail' ? 'FAILED'
      : /started|listening|serving|running in a background terminal/i.test(out) ? 'started (server)'
      : 'ran';
    const install = INSTALL_RE.test(cmd);
    return makeEvidence('RUNTIME', 'run_command',
      `run: ${cmd.slice(0, 100)} → ${res}` +
      (install ? ' [installs a dependency → modifies the package manifest/lockfile, NOT shown in the diff]' : ''),
      result, phase, install ? { tags: ['dependency-install'] } : undefined);
  }

  if (name === 'verify_visual') {
    const p = String(args.path || '').trim();
    const verdictLine = (out.match(/verdict:\s*\w+/i) || [out.split('\n')[0].slice(0, 40)])[0];
    const result: EvidenceResult = /verdict:\s*ok\b/i.test(out) ? 'pass'
      : /verdict:\s*mismatch/i.test(out) ? 'fail' : 'inconclusive';
    return makeEvidence('VISUAL_COMPARISON', 'verify_visual',
      `verify_visual(${p}) → ${verdictLine}`, result, phase,
      p ? { artifactRefs: [p] } : undefined);
  }

  if (name === 'get_diagnostics') {
    return makeEvidence('DIAGNOSTIC', 'get_diagnostics',
      `get_diagnostics → ${out.split('\n')[0].slice(0, 80)}`, 'info', phase);
  }

  if (name === 'read_terminal_output') {
    return makeEvidence('LOG', 'read_terminal_output',
      'read_terminal_output → checked a running terminal', 'info', phase);
  }

  if (name === 'read_probes') {
    const silent = /never hit/i.test(out);
    const noData = /no probe (data|output)|0 sample/i.test(out);
    return makeEvidence('PROBE', 'read_probes',
      `read_probes → ${out.split('\n')[0].slice(0, 80)}`,
      noData ? 'inconclusive' : 'pass', phase,
      silent ? { tags: ['probe-never-hit'] } : undefined);
  }

  if (name === 'screenshot_url') {
    const saved = out.match(/^Saved screenshot to "([^"]+)"/);
    return makeEvidence('SCREENSHOT', 'screenshot_url',
      `screenshot_url → ${saved ? saved[1] : out.split('\n')[0].slice(0, 60)}`,
      saved ? 'info' : 'fail', phase,
      saved ? { artifactRefs: [saved[1]] } : undefined);
  }

  if (name === 'debug_start' || name === 'debug_inspect' || name === 'debug_evaluate' ||
      name === 'debug_continue' || name === 'debug_step') {
    return makeEvidence('DEBUGGER', name,
      `${name} → ${out.split('\n')[0].slice(0, 80)}`, 'info', phase);
  }

  if (name === 'lab_run') {
    const failed = /FAILED|TIMED OUT/i.test(out.split('\n')[0] || '');
    return makeEvidence('RUNTIME', 'lab_run',
      `lab_run(${args.name || args.language || 'script'}) → ${failed ? 'FAILED' : 'ok'}`,
      failed ? 'fail' : 'pass', phase);
  }

  if (name === 'lab_benchmark') {
    const stat = (out.match(/mean [^·\n]+/) || [''])[0].trim();
    const failed = /harness failed/i.test(out);
    return makeEvidence('BENCHMARK', 'lab_benchmark',
      `lab_benchmark(${args.label || '?'}) → ${failed ? 'harness failed' : stat || 'measured'}`,
      failed ? 'inconclusive' : 'pass', phase);
  }

  if (name === 'lab_diff_test') {
    const m = out.match(/(\d+) case\(s\) → (\d+) identical, (\d+) different, (\d+) error/);
    const failed = /harness (failed|error)/i.test(out);
    const different = m ? parseInt(m[3], 10) : 0;
    const errors = m ? parseInt(m[4], 10) : 0;
    return makeEvidence('DIFFERENTIAL_TEST', 'lab_diff_test',
      `lab_diff_test → ${m ? `${m[2]}/${m[1]} identical, ${different} different, ${errors} errors` : 'harness failed'}`,
      failed || !m ? 'inconclusive' : (different > 0 ? 'fail' : 'pass'), phase);
  }

  if (name === 'lab_profile') {
    const top = (out.split('\n')[1] || '').trim().replace(/\s+/g, ' ').slice(0, 90);
    const failed = /harness failed|no profile|no samples/i.test(out);
    return makeEvidence('BENCHMARK', 'lab_profile',
      `lab_profile → ${failed ? 'no usable profile' : `hottest: ${top}`}`,
      failed ? 'inconclusive' : 'pass', phase);
  }

  if (name === 'lab_scaling') {
    const m = out.match(/OBSERVED SCALING[^:]*: (~[^\n—]+)( — LOW CONFIDENCE)?/);
    return makeEvidence('BENCHMARK', 'lab_scaling',
      `lab_scaling → ${m ? m[1].trim() + (m[2] ? ' (low confidence)' : '') : 'harness failed'}`,
      m && !m[2] ? 'pass' : 'inconclusive', phase);
  }

  return undefined; // reads/edits aren't behavioural evidence (the diff covers edits)
}

/** The judge-prompt projection: `[pre-edit] run: npm test → ok`. */
export function renderEvidenceLine(item: EvidenceItem): string {
  return `[${item.phase}] ${item.description}`;
}

export interface VerificationSummary {
  behavioral: number;          // behavioural evidence items
  behavioralFailed: number;    // …of which failed
  checks: number;              // static/gate checks
  checksFailed: number;
  /** Honest one-line classification for the user-facing chip. */
  label: 'MEASURED' | 'TESTED' | 'STATIC-ONLY' | 'UNVERIFIED';
}

/** Summarize what the evidence actually demonstrates. Never inflates. */
export function verificationSummary(items: EvidenceItem[]): VerificationSummary {
  items = currentEvidence(items);
  const behavioralItems = items.filter(isBehavioral);
  const checkItems = items.filter(i => !isBehavioral(i));
  const measured = behavioralItems.some(i =>
    (i.type === 'BENCHMARK' || i.type === 'PROBE') && i.result !== 'inconclusive');
  const tested = behavioralItems.some(i => i.result === 'pass' || i.result === 'fail');
  return {
    behavioral: behavioralItems.length,
    behavioralFailed: behavioralItems.filter(i => i.result === 'fail').length,
    checks: checkItems.length,
    checksFailed: checkItems.filter(i => i.result === 'fail').length,
    label: measured ? 'MEASURED' : tested ? 'TESTED' : checkItems.length ? 'STATIC-ONLY' : 'UNVERIFIED',
  };
}
