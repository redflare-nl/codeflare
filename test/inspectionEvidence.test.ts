import { describe, expect, it } from 'vitest';
import { classifyToolEvidence, isInspectionCommand } from '../src/engine/evidence';
import { decideAcceptance } from '../src/engine/experiment';
import { isTestCommand, testAuthorPrompt } from '../src/engine/testWorkflow';

const run = (command: string, exit: number) =>
  classifyToolEvidence('run_command', JSON.stringify({ command }), `output\nExit code: ${exit}`, 'post-edit')!;

describe('inspection commands are not behavioural checks', () => {
  it('recognises read-only listing and printing, including pipelines', () => {
    for (const c of ['dir C:\Projects\games\bonanza /s /b', 'ls -la', 'Get-ChildItem -Recurse "x" -Name',
      'Get-Content orbit.html | Measure-Object -Line', 'type .env.local', 'git status', 'where node', 'cat a.txt | head -5']) {
      expect(isInspectionCommand(c), c).toBe(true);
    }
  });

  it('keeps anything that runs project code as a runtime check', () => {
    for (const c of ['node test_orbit.js', 'npm test', 'python -m http.server 8080', 'cd game && npm test',
      'npx playwright screenshot http://localhost:8080 a.png', 'python -c "import re; print(1)"', 'dir && node build.js']) {
      expect(isInspectionCommand(c), c).toBe(false);
    }
  });

  it('turns a failed dir into info, so it can no longer REJECT a mission', () => {
    const failed = run('dir C:\Projects\games\bonanza /s /b', 1);
    expect(failed).toMatchObject({ type: 'RUNTIME', result: 'info' });
    expect(failed.description).toMatch(/not a behavioural check/);
    const decision = decideAcceptance({ gates: {}, filesChanged: 1, outcome: 'completed', behaviorRequired: false,
      evidence: [failed, run('node test_game.js', 0)] } as any);
    expect(decision.decision).not.toBe('REJECTED');
  });

  it('still rejects on a failing run of project code', () => {
    expect(run('node test_game.js', 1)).toMatchObject({ type: 'RUNTIME', result: 'fail' });
    expect(decideAcceptance({ gates: {}, filesChanged: 1, outcome: 'completed', behaviorRequired: false,
      evidence: [run('node test_game.js', 1)] } as any).decision).toBe('REJECTED');
  });
});

describe('test author without a test framework', () => {
  const prompt = testAuthorPrompt('Make a one-button HTML game', ['index.html']);
  it('may create new test files and gets a zero-install route', () => {
    expect(prompt).toMatch(/You may CREATE new test files/);
    expect(prompt).toMatch(/node --test tests\//);
    expect(prompt).toMatch(/node:vm/);
  });
  it('proposes a command the coordinator actually accepts', () => {
    expect(isTestCommand('node --test tests/')).toBe(true);
  });
});
