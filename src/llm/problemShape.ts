// Pure, dependency-free request classification for adaptive reasoning depth.
// Kept out of prompts.ts (which pulls in the vscode config chain) so it can be
// unit-tested directly — the same reason labHarness/gitIsolation are vscode-free.

// The "problem shape" of a turn. `null` (no strong signal, or a trivial
// mechanical edit) means NO reasoning-discipline block is injected, so simple
// tasks stay fast and pay no extra tokens.
export type ProblemShape = 'debug' | 'perf' | 'puzzle' | 'reason' | 'create';

// Open-ended invention: the request asks for something NEW and leaves the idea
// to the agent. Needs an explicit novelty cue AND a making verb, so "optimize
// the original game loop" or "restore the original design" never qualify.
const NOVELTY_RE = /(\boriginal\s+(?:[\w-]+\s+){0,3}(game|app|idea|concept|design|story|name|logo|product|website|mechanic)|\borigine(el|le)\b|\boriginality\b|\bnovel\s+(game|idea|concept|mechanic)|\bunique\s+(game|idea|concept|mechanic)|\buniek\b|\b(own|eigen)\s+(concept|idea|idee|identity|identiteit)|\bnew\s+concept\b|\bnieuw\s+concept\b|\bbedenk\s+(zelf|een|iets)\b|\bverzin\b|\bcome\s+up\s+with\b|\binvent\b|\bbrainstorm|\bnot\s+a\s+(?:[\w-]+\s+){0,3}clone\b|\bgeen\s+\S*kloon\b|\bcreative\b|\bcreatie(f|ve)\b)/i;
const MAKE_RE = /\b(make|build|create|design|write|generate|come\s+up|invent|maak|bouw|ontwerp|schrijf|genereer|bedenk|verzin)\b/i;
const REPAIR_RE = /\b(fix|bug|crash\w*|repair|herstel\w*|debug\w*|regress\w*|restore|revert)\b/i;

/**
 * Classify a request into a problem shape for adaptive reasoning depth. Cheap,
 * deterministic, and CONSERVATIVE: returns a shape only on a strong signal and
 * otherwise `null`, so ordinary or trivial requests get no reasoning ceremony.
 * Order matters — an explicit invention brief wins (see below); then
 * performance and debugging cues win over the broader architecture/algorithm
 * cues because they demand more specific discipline.
 * Advisory (review) requests have their own discipline block and are classified
 * upstream, so they never reach this.
 */
export function classifyProblem(text: string): ProblemShape | null {
  const t = text || '';
  // Invention first: a long creative brief routinely also says "optimize for
  // fast loading" or "the player fails", which must not turn it into perf/debug.
  if (NOVELTY_RE.test(t) && MAKE_RE.test(t) && !REPAIR_RE.test(t)) {
    return 'create';
  }
  // Performance: the request is about speed/memory/scaling — measure, don't guess.
  if (/\b(slow(er|ness)?|too\s+slow|speed\s*(it)?\s*up|faster|optimi[sz]e|optimi[sz]ation|performance|perf\b|latenc|throughput|bottleneck|lag(g|s|gy)?|stutter|jank|\d+\s*fps|frame\s*rate|memory\s+(leak|usage|growth)|allocat|hot\s*path|profil)/i.test(t)) {
    return 'perf';
  }
  // Debugging: something is wrong / not behaving — form hypotheses, get evidence.
  if (/\b(bug|crash(es|ing|ed)?|hang(s|ing)?|freeze|frozen|broke(n)?|fails?|failing|failed|errors?|throw(s|ing|n)?|exception|wrong|incorrect|unexpected|regress|doesn'?t\s+work|does\s+not\s+work|not\s+working|stopped\s+working|won'?t\s+\w+|null\s+(pointer|ref)|undefined\b|nan\b|race\s+condition|deadlock|flak(y|ey)|intermittent|why\s+(is|does|isn'?t|doesn'?t|won'?t|can'?t))/i.test(t)) {
    return 'debug';
  }
  // Algorithmic / puzzle: pure reasoning where runtime probes are often useless.
  if (/\b(algorithm|complexity|big[- ]?o\b|o\([^)]*\)|recursi|dynamic\s+programming|memoi[sz]|invariant|combinatori|permutation|backtrack|graph\s+(traversal|search)|dijkstra|bfs\b|dfs\b|state\s+machine|parse[rs]?\b|tokeni[sz]|leetcode|coding\s+(puzzle|challenge)|edge\s+cases?)/i.test(t)) {
    return 'puzzle';
  }
  // Architecture / substantial change: understand the existing design first.
  if (/\b(refactor|re-?architect|architecture|redesign|restructure|migrat|decoupl|coupling|cohesion|abstraction|extract\s+(a\s+)?(module|class|interface|service)|separation\s+of\s+concerns|trade[- ]?offs?|design\s+(a|the|an)\b)/i.test(t)) {
    return 'reason';
  }
  return null;
}
