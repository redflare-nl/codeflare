import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/** Minimal DOM for the footer: host strings must always use textContent. */
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  listeners: Record<string, () => void> = {};
  hidden = false;
  disabled = false;
  checked = false;
  value = '';
  className = '';
  private text = '';
  classList = {
    contains: (name: string) => this.className.split(' ').includes(name),
    toggle: (name: string, enabled: boolean) => {
      const values = new Set(this.className.split(' ').filter(Boolean));
      if (enabled) { values.add(name); } else { values.delete(name); }
      this.className = [...values].join(' ');
    },
  };
  set textContent(value: string) { this.text = String(value); this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_: string) { throw new Error('Mission data must not be interpreted as HTML'); }
  append(...children: Element[]) { this.children.push(...children); }
  appendChild(child: Element) { this.append(child); return child; }
  prepend(child: Element) { this.children.unshift(child); }
  before(_: Element) { /* footer is inserted adjacent to the input */ }
  replaceChildren(...children: Element[]) { this.children = children; this.text = ''; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  addEventListener(name: string, handler: () => void) { this.listeners[name] = handler; }
  click() { if (!this.disabled) { this.listeners.click?.(); } }
}

const source = readFileSync(path.resolve('media/chat.js'), 'utf8');
function section(from: string, to: string) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  if (start < 0 || end < 0) { throw new Error(`Missing webview source section: ${from}`); }
  return source.slice(start, end);
}

function footerHarness() {
  const sent: unknown[] = [];
  const sendBtn = new Element();
  const stopBtn = new Element();
  const inputArea = new Element();
  const configOverlay = new Element();
  configOverlay.className = 'hidden';
  const agentLimitInput = new Element();
  const context = vm.createContext({
    document: { createElement: () => new Element(), getElementById: () => inputArea },
    vscode: { postMessage: (message: unknown) => { sent.push(JSON.parse(JSON.stringify(message))); } },
    sendBtn, stopBtn,
    isStreaming: false, currentBubble: null, currentContent: '', thinkContent: '',
    lastConfig: { autonomousMode: false, autoTest: false },
    configOverlay, agentLimitInput, agentLimitDirty: false, endpointLabel: null,
    // applyConfigState also refreshes the mission-budget fields; they have their
    // own harness below, so the footer only needs them to exist.
    missionBudgetDirty: false, fillMissionBudget: () => {},
    clearToolProgress: () => {}, scrollToBottom: () => {}, showWaiting: () => {},
  });
  // Exercise the production footer, stream lifecycle and Stop handler without
  // emulating unrelated transcript/Markdown or importing a browser dependency.
  vm.runInContext([
    section('  const MISSION_PHASES =', '  // ── Markdown rendering'),
    section('  function startStreaming()', '  // Create the streaming bubble'),
    section('  function finishStreaming(', '  // ── Code action buttons'),
    section('  function applyConfigState(', '  function shortenEndpoint('),
    section("  stopBtn.addEventListener('click'", "  clearBtn.addEventListener('click'"),
  ].join('\n'), context);
  const run = (script: string) => vm.runInContext(script, context);
  const mission = (status: string, phase = 'verify') => {
    run(`renderMission(${JSON.stringify({ status, phase, activity: 'Tests controleren', testStatus: 'running', agents: [], transitions: [] })}, 8)`);
  };
  return { run, mission, sendBtn, stopBtn, agentLimitInput, sent };
}

describe('live mission footer', () => {
  it('keeps Stop available after the implementation stream ends and throughout the separate test stage', () => {
    const ui = footerHarness();
    ui.mission('running', 'build');
    ui.run('startStreaming(); finishStreaming();');
    expect(ui.stopBtn.style.display).toBe('inline-block');
    expect(ui.sendBtn.style.display).toBe('none');
    ui.mission('running', 'verify');
    ui.stopBtn.click();
    expect(ui.sent).toEqual([{ type: 'stopGeneration' }]);
    // A stop request does not claim the host has already finished stopping.
    expect(ui.stopBtn.style.display).toBe('inline-block');
    ui.mission('paused');
    expect(ui.stopBtn.style.display).toBe('none');
    expect(ui.sendBtn.style.display).toBe('inline-block');
    expect(ui.run('missionResume.disabled')).toBe(false);
    expect(ui.run('currentBubble')).toBe(null);
  });

  it.each(['completed', 'paused', 'failed', 'interrupted'])
  ('ends mission busy state when the host reports %s', status => {
    const ui = footerHarness();
    ui.mission('running');
    ui.mission(status);
    expect(ui.stopBtn.style.display).toBe('none');
    expect(ui.sendBtn.style.display).toBe('inline-block');
    expect(ui.run('missionResume.hidden')).toBe(status === 'completed');
  });

  it('retains Stop for a stream still in flight even if its mission was cleared', () => {
    const ui = footerHarness();
    ui.run('startStreaming(); renderMission(null);');
    expect(ui.stopBtn.style.display).toBe('inline-block');
    ui.run('finishStreaming();');
    expect(ui.stopBtn.style.display).toBe('none');
  });

  it('shows actual phase reversal and keeps host content as text', () => {
    const ui = footerHarness();
    ui.run(`renderMission({status:'running',phase:'build',activity:'<img onerror=alert(1)>',
      agents:[{id:'agent-1',task:'API',status:'running'},{id:'agent-2',task:'UX',status:'queued'}],
      transitions:[{from:'verify',to:'build',reason:'Leeg bestand faalt',at:1,backward:true}]}, 8);`);
    expect(ui.run('missionCount.textContent')).toBe('1 / 8 agents actief');
    expect(ui.run('missionPhaseNodes[2].attributes["aria-current"]')).toBe('step');
    expect(ui.run('missionPhaseNodes[3].attributes["aria-current"]')).toBeUndefined();
    expect(ui.run('missionReturn.textContent')).toContain('Leeg bestand faalt');
    expect(ui.run('missionActivity.textContent')).toContain('<img onerror=alert(1)>');
    expect(ui.run('missionHistory.children.length')).toBe(1);
  });

  it('keeps the live pool limit when settings change and applies the new cap after the mission', () => {
    const ui = footerHarness();
    ui.run('applyConfigState({maxParallelAgents:32});');
    ui.mission('running'); // The host's actual pool limit is 8.
    expect(ui.run('missionCount.textContent')).toBe('0 / 8 agents actief');
    ui.run('applyConfigState({maxParallelAgents:2});');
    expect(ui.agentLimitInput.value).toBe('2');
    expect(ui.run('missionCount.textContent')).toBe('0 / 8 agents actief');
    ui.mission('completed'); // The old pool's 8 must not overwrite future settings.
    expect(ui.run('missionCount.textContent')).toBe('0 / 2 agents actief');
    ui.run("renderMission({status:'running',phase:'build',activity:'Nieuwe opdracht'},2);");
    expect(ui.run('missionCount.textContent')).toBe('0 / 2 agents actief');
  });
});

describe('memory status (Settings → Memory)', () => {
  // Runs the PRODUCTION applyMemoryState from chat.js.
  function memoryHarness() {
    const status = new Element();
    const buttons = [new Element(), new Element(), new Element()];
    const context = vm.createContext({
      memoryStatusEl: status,
      reflectButton: new Element(),
      memoryButtons: [{ button: buttons[0], scope: 'project' }, { button: buttons[1], scope: 'global' }, { button: buttons[2], scope: 'all' }],
      textElement: (_tag: string, cls = '', text = '') => { const e = new Element(); e.className = cls; e.textContent = text; return e; },
    });
    vm.runInContext(section('  function applyMemoryState(state) {', '  const PROVIDER_META = {'), context);
    return { status, buttons, run: (script: string) => vm.runInContext(script, context) };
  }

  it('names the project the counts belong to and separates shared agent memory', () => {
    const ui = memoryHarness();
    ui.run("applyMemoryState({ available: true, projectAvailable: true, project: 'AgiTest_III', projectSkills: 0, globalSkills: 1, validatedSkills: 0, episodes: 0 })");
    const text = ui.status.textContent;
    expect(text).toContain('This project (AgiTest_III): 0 skill(s), 0 recorded experiment(s).');
    expect(text).toContain('Agent memory (shared by all projects): 1 skill(s).');
    expect(text).toContain('0 validated — only validated skills are reused automatically');
    expect(text).toContain('Each project keeps its own memory');
    expect(text).not.toContain('Stored now'); // the old, scope-less wording
  });

  it('says plainly when this window has no project storage, and disables project actions', () => {
    const ui = memoryHarness();
    ui.run("applyMemoryState({ available: true, projectAvailable: false, projectSkills: 0, globalSkills: 2, validatedSkills: 1, episodes: 0 })");
    expect(ui.status.textContent).toContain('This project: no project storage in this window.');
    expect(ui.buttons.map(b => b.disabled)).toEqual([true, false, true]);
  });
});

describe('mission budget fields (Settings → Budget)', () => {
  // Loads the PRODUCTION block from chat.js, so this breaks if the fields change.
  function budgetHarness() {
    const tabs = new Element();
    const context = vm.createContext({
      document: {
        createElement: () => new Element(),
        // '.config-tabs' receives the tab; '.config-actions' is only an insertion anchor.
        querySelector: (selector: string) => selector === '.config-tabs' ? tabs : new Element(),
      },
      textElement: (_tag: string, cls = '', text = '') => { const e = new Element(); e.className = cls; e.textContent = text; return e; },
    });
    vm.runInContext(section('  // ── Mission budget (autonomous missions as a whole)', '  function selectConfigTab('), context);
    const run = (script: string) => vm.runInContext(script, context);
    return { tabs, pane: run('budgetConfigPane') as Element, run };
  }

  it('lives in its own "Budget" tab, not under Agents', () => {
    const ui = budgetHarness();
    expect(ui.tabs.children).toHaveLength(1);
    expect(ui.tabs.children[0].textContent).toBe('Budget');
    expect(ui.tabs.children[0].dataset.tab).toBe('budget');
    expect(ui.pane.dataset.pane).toBe('budget');
    expect(ui.pane.className).toContain('hidden');
  });

  it('renders one whole-number field per budget ceiling, minimum 0', () => {
    const ui = budgetHarness();
    expect(ui.run('MISSION_BUDGET_FIELDS.map(f => f[0]).join(",")')).toBe('maxTurns,maxToolCalls,maxTokens,maxWallMinutes,maxStalledTurns');
    for (const key of ['maxTurns', 'maxToolCalls', 'maxTokens', 'maxWallMinutes', 'maxStalledTurns']) {
      const input = ui.run(`missionBudgetInputs.${key}`);
      expect(input.type, key).toBe('number');
      expect(input.min, key).toBe('0');
      expect(input.step, key).toBe('1');
    }
    // One explanatory hint, then the five fields.
    expect(ui.pane.children).toHaveLength(6);
    expect(ui.pane.children[0].className).toBe('config-hint');
  });

  it('fills from the host state and leaves a field empty rather than inventing a value', () => {
    const ui = budgetHarness();
    ui.run('fillMissionBudget({ maxTurns: 48, maxToolCalls: 2400, maxTokens: 6000000, maxWallMinutes: 360, maxStalledTurns: 12 })');
    expect(ui.run('missionBudgetInputs.maxTurns.value')).toBe('48');
    expect(ui.run('missionBudgetInputs.maxWallMinutes.value')).toBe('360');
    ui.run('fillMissionBudget({ maxTurns: 5 })');
    expect(ui.run('missionBudgetInputs.maxTurns.value')).toBe('5');
    expect(ui.run('missionBudgetInputs.maxTokens.value')).toBe('');
  });

  it('marks the form dirty once the user types, so a host refresh does not overwrite the edit', () => {
    const ui = budgetHarness();
    expect(ui.run('missionBudgetDirty')).toBe(false);
    ui.run('missionBudgetInputs.maxTurns.listeners.input()');
    expect(ui.run('missionBudgetDirty')).toBe(true);
  });
});
