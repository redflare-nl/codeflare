export function testAuthorPrompt(task: string, files: string[]): string {
  return `Independent test task. Evaluate the ORIGINAL REQUEST, not the implementer's claims.\n` +
    `ORIGINAL REQUEST:\n${task}\n\nCHANGED FILES:\n${files.join('\n')}\n\n` +
    'Read existing tests and project configuration. Identify observable acceptance criteria, normal cases, ' +
    'edge cases and regressions. Write missing meaningful unit/integration tests using the existing framework. ' +
    'Only test files may be edited; do not change production code, dependencies, test configuration, ' +
    'or weaken existing assertions. Report implementation defects for the coordinator to repair. ' +
    'Do not fabricate test results: execution is performed by the coordinator after you finish. ' +
    'In your RESULT block include TEST_COMMAND: one existing project test command, without shell chaining, ' +
    'watch mode, or no-tests/pass flags; use none if there is no runnable framework. ' +
    'Explain remaining coverage gaps in OPEN. Existing adequate tests may be reused. ' +
    'A build, linter, screenshot, or echo command is not a test suite.';
}

/** Admit a single test-runner invocation; normal command permissions still apply. */
export function isTestCommand(command: string): boolean {
  if (!command || command.length > 1000 || /[\r\n;&|<>`$%^]/.test(command)) { return false; }
  // Quote removal also catches shell-concatenated flag spellings, while the
  // executable itself must match literally (no shell wrappers or expansion).
  const normalized = command.trim();
  const runner = /^(?:npm (?:test|run test[\w:.-]*)|(?:pnpm|yarn) (?:run )?test[\w:.-]*|(?:npx )?(?:vitest run|jest|mocha|playwright test)|(?:python[3]? -m )?(?:pytest|unittest)|node --test|cargo test|go test|dotnet test|mvn test|(?:\.\/)?gradlew? test)(?=\s|$)/i.exec(normalized);
  if (!runner) { return false; }
  if (/(?:^|[:.-])(?:watch|dev|list|dry-run)(?:$|[:.-])/i.test(runner[0])) { return false; }
  const args = normalized.slice(runner[0].length).replace(/["']/g, '');
  return !/(?:^|\s)--(?:watch(?:All)?|pass-?with-?no-?tests|no-tests?|collect-?only|co|no-run|list(?:-tests|Tests)?|dry-?run|help|version)(?:[=\s]|$)/i.test(args) &&
    !/(?:^|\s)-(?:w|h|V|\?)(?:[=\s]|$)/.test(args) &&
    !/(?:^|\s)-D(?:skipTests|maven\.test\.skip)(?:[=\s]|$)/i.test(args) &&
    !(/gradlew? test$/i.test(runner[0]) && /(?:^|\s)-(?:m|x)(?:[=\s]|$)/.test(args)) &&
    !(/^dotnet test$/i.test(runner[0]) && /(?:^|\s)-t(?:[=\s]|$)/.test(args)) &&
    !(/^go test$/i.test(runner[0]) && /(?:^|\s)-list(?:[=\s]|$)/.test(args));
}

export function testExecutionVerdict(output: string): 'passed' | 'failed' | 'incomplete' {
  if (/exit code:\s*(?:[1-9]\d*|-[1-9]\d*)\b/i.test(output)) { return 'failed'; }
  if (!/exit code:\s*0\b/i.test(output)) { return 'incomplete'; }
  if (/\b[1-9]\d*\s+(?:failed|failures)\b|\b(?:Failures|Errors|Failed):\s*[1-9]\d*\b|^#\s*fail\s+[1-9]\d*\b/im.test(output)) { return 'failed'; }
  // Go emits an "ok" line even when a filter selected zero tests.
  if (/no tests? to run/i.test(output)) { return 'incomplete'; }
  // Recognizable executed-test evidence is required: an arbitrary script that
  // exits 0 (or only builds/lints) does not establish that tests ran. Empty
  // auxiliary packages/doc-tests do not cancel another suite's positive count.
  const positive = /\b[1-9]\d*\s+(?:passed|passing|examples?)\b|\bPassed:\s*[1-9]\d*\b|\bRan\s+[1-9]\d*\s+tests?\b|^#\s*pass\s+[1-9]\d*\b/im.test(output) ||
    /^ok\s+\S+\s+(?:[\d.]+s|\(cached\))(?:\s|$)/im.test(output) ||
    output.split(/\r?\n/).some(line => /^ok\s+\d+\b/i.test(line) && !/#\s*(?:skip|todo)\b/i.test(line)) ||
    [...output.matchAll(/Tests run:\s*(\d+),\s*Failures:\s*0,\s*Errors:\s*0,\s*Skipped:\s*(\d+)/gi)]
      .some(match => Number(match[1]) > Number(match[2]));
  return positive ? 'passed' : 'incomplete';
}
