import { describe, expect, it } from 'vitest';
import { isTestCommand, testExecutionVerdict } from '../src/engine/testWorkflow';

describe('independent test command validation', () => {
  it.each([
    'npm test -- --run', 'npm run test:unit', 'pnpm test --run', 'yarn run test:unit',
    'npx vitest run test/upload.test.ts', 'vitest run', 'npx jest --runInBand',
    'mocha test/upload.js', 'npx playwright test', 'pytest -q tests/',
    'python -m pytest tests/test_upload.py', 'python3 -m unittest discover',
    'node --test test/upload.test.js', 'cargo test --workspace', 'go test ./...',
    'dotnet test App.sln', 'mvn test', './gradlew test', 'gradle test',
  ])('admits a single existing test-runner invocation: %s', command => {
    expect(isTestCommand(command)).toBe(true);
  });

  it.each([
    '', '   ', 'none', 'npm run build', 'npx tsc --noEmit', 'echo passed',
    'npm install', 'python app.py', 'bash -c "npm test"', 'vitest',
    'npm test && npm publish', 'npm test; echo passed', 'npm test | cat',
    'npm test > result.txt', 'npm test\nnode next.js', 'npm test\rnode next.js',
    'npm test $(echo passed)', 'npm test `echo passed`',
    'npx jest --watchAll', 'npx jest --passWithNoTests',
    'pytest --collect-only', 'mocha --watch', 'npm test -- --watch',
  ])('blocks a non-test, composed, interactive or success-without-tests command: %s', command => {
    expect(isTestCommand(command)).toBe(false);
  });

  it('bounds the command before sending it to a runner', () => {
    expect(isTestCommand(`pytest ${'x'.repeat(1001)}`)).toBe(false);
  });

  it.each([
    'vitest run -w', 'pytest --co', 'cargo test --no-run',
    'dotnet test --list-tests', 'mvn test -DskipTests', './gradlew test --dry-run',
    'dotnet test -t', 'go test -list .', 'pytest --collectonly',
    'npx playwright test --pass-with-no-tests', 'npx jest --listTests',
    'npm run test:watch', './gradlew test -m', 'mvn test -Dmaven.test.skip=true',
    'npx jest --wa"tch"',
  ])('rejects runner aliases that watch, list or skip execution: %s', command => {
    expect(isTestCommand(command)).toBe(false);
  });
});

describe('test execution evidence', () => {
  it.each([
    'Tests  12 passed (12)\nExit code: 0',
    '================ 8 passed in 0.12s ================\nExit code: 0',
    'Ran 3 tests in 0.002s\nOK\nExit code: 0',
    'test result: ok. 12 passed; 0 failed; 0 ignored\nExit code: 0',
    'ok example.org/app 0.1s\nExit code: 0',
    '  10 passing (16ms)\nExit code: 0',
    'Tests: 20 passed, 20 total\nExit code: 0',
    '# tests 4\n# pass 4\n# fail 0\nExit code: 0',
    'Passed! - Failed: 0, Passed: 5, Skipped: 0, Total: 5\nExit code: 0',
    'Tests run: 5, Failures: 0, Errors: 0, Skipped: 1\nExit code: 0',
    'ok 1 - uploads a file\n1..1\nExit code: 0',
  ])('requires a successful process and accepts real successful suites: %s', output => {
    expect(testExecutionVerdict(output)).toBe('passed');
  });

  it.each([
    'Tests 2 failed, 10 passed\nExit code: 1',
    'All assertions passed\nExit code: 2',
    'Process killed\nExit code: -9',
    'Previous exit code: 0\nActual exit code: 137',
    'Tests: 2 failed, 10 passed\nExit code: 0',
  ])('a process failure takes precedence over optimistic output: %s', output => {
    expect(testExecutionVerdict(output)).toBe('failed');
  });

  it.each(['', 'All tests passed', 'Tests: 4 passed', 'Execution timed out', 'Exit code: unknown'])
  ('does not claim completion without process exit evidence: %s', output => {
    expect(testExecutionVerdict(output)).toBe('incomplete');
  });

  it.each([
    'No tests found\nExit code: 0', 'no tests ran in 0.01s\nExit code: 0',
    'collected 0 items\nExit code: 0', 'Ran 0 tests in 0.001s\nOK\nExit code: 0',
    'Tests: 0 total\nExit code: 0', '0 passing (1ms)\nExit code: 0',
    '? example.org/app [no test files]\nExit code: 0',
    'testing: warning: no tests to run\nPASS\nExit code: 0',
    'running 0 tests\ntest result: ok. 0 passed; 0 failed\nExit code: 0',
    'Tests run: 0, Failures: 0, Errors: 0, Skipped: 0\nExit code: 0',
    'No test is available in App.dll.\nExit code: 0',
    '# tests 4\n# pass 0\n# skipped 4\nExit code: 0',
    'Tests run: 5, Failures: 0, Errors: 0, Skipped: 5\nExit code: 0',
    'ok 1 - placeholder # SKIP\n1..1\nExit code: 0',
    'Build succeeded\nExit code: 0', 'All tests passed\nExit code: 0',
    'Exit code: 0',
  ])('does not mistake an empty suite for verification: %s', output => {
    expect(testExecutionVerdict(output)).toBe('incomplete');
  });

  it('allows a Go package without tests when another package ran successfully', () => {
    expect(testExecutionVerdict([
      '? example.org/app/cmd [no test files]',
      'ok example.org/app/service 0.231s',
      'Exit code: 0',
    ].join('\n'))).toBe('passed');
  });
});
