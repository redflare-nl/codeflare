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
