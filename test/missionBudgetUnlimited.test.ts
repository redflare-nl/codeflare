import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as vm from 'vm';

// ── Settings → Budget: the "Onbeperkt" switches (media/chat.js) ──────────────
class El {
  children: El[] = []; dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
  listeners: Record<string, () => void> = {}; disabled = false; checked = false; value = ''; className = '';
  type = ''; id = ''; min = ''; step = ''; required = false; textContent = '';
  append(...c: El[]) { this.children.push(...c); } appendChild(c: El) { this.append(c); return c; }
  before() { /* insertion anchor */ } setAttribute(n: string, v: string) { this.attributes[n] = v; }
  addEventListener(n: string, h: () => void) { this.listeners[n] = h; }
}
const source = readFileSync(path.resolve('media/chat.js'), 'utf8');
const section = (from: string, to: string) => {
  const s = source.indexOf(from); const e = source.indexOf(to, s);
  if (s < 0 || e < 0) { throw new Error(`Missing section ${from}`); }
  return source.slice(s, e);
};
function budgetTab() {
  const context = vm.createContext({
    document: { createElement: () => new El(), querySelector: () => new El() },
    textElement: (_t: string, cls = '', text = '') => { const e = new El(); e.className = cls; e.textContent = text; return e; },
  });
  vm.runInContext(section('  // ── Mission budget (autonomous missions as a whole)', '  function selectConfigTab('), context);
  return (script: string) => vm.runInContext(script, context);
}

describe('Budget tab — unlimited switches', () => {
  it('shows a saved 0 as "Onbeperkt", with the number field disabled', () => {
    const run = budgetTab();
    run('fillMissionBudget({ maxTurns: 192, maxToolCalls: 9600, maxTokens: 0, maxWallMinutes: 1440, maxStalledTurns: 48 }, true)');
    expect(run('missionBudgetUnlimited.maxTokens.checked')).toBe(true);
    expect(run('missionBudgetInputs.maxTokens.disabled')).toBe(true);
    expect(run('missionBudgetUnlimited.maxTurns.checked')).toBe(false);
    expect(run('missionBudgetLocalTokens.checked')).toBe(true);
  });

  it('saves an unlimited ceiling as 0 and restores the last number when switched back', () => {
    const run = budgetTab();
    run('fillMissionBudget({ maxTurns: 192, maxToolCalls: 9600, maxTokens: 30000000, maxWallMinutes: 1440, maxStalledTurns: 48 }, false)');
    expect(run('missionBudgetLocalTokens.checked')).toBe(false);
    run('missionBudgetUnlimited.maxTokens.checked = true; missionBudgetUnlimited.maxTokens.listeners.change()');
    expect(run('readMissionBudget().maxTokens')).toBe(0);
    expect(run('missionBudgetDirty')).toBe(true);
    run('missionBudgetUnlimited.maxTokens.checked = false; missionBudgetUnlimited.maxTokens.listeners.change()');
    expect(run('missionBudgetInputs.maxTokens.value')).toBe('30000000');
    expect(run('readMissionBudget().maxTokens')).toBe(30000000);
  });

  it('falls back to the shipped default when a field was unlimited from the start', () => {
    const run = budgetTab();
    run('fillMissionBudget({ maxTurns: 0, maxToolCalls: 9600, maxTokens: 0, maxWallMinutes: 1440, maxStalledTurns: 48 }, true)');
    run('missionBudgetUnlimited.maxTurns.checked = false; missionBudgetUnlimited.maxTurns.listeners.change()');
    expect(run('missionBudgetInputs.maxTurns.value')).toBe('192');
  });

  it('keeps the shipped defaults in the webview identical to the engine', async () => {
    const { DEFAULT_MISSION_BUDGET, missionBudgetToSettings } = await import('../src/engine/missionBudget');
    expect(budgetTab()('MISSION_BUDGET_DEFAULTS')).toEqual(missionBudgetToSettings(DEFAULT_MISSION_BUDGET));
  });

  it('has the local-model toggle declared as a setting, default on', () => {
    const pkg = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));
    const prop = pkg.contributes.configuration.properties ?? Object.assign({}, ...pkg.contributes.configuration.map((c: any) => c.properties));
    expect(prop['codeflare.missionBudget.localUnlimitedTokens']).toMatchObject({ type: 'boolean', default: true });
  });
});
