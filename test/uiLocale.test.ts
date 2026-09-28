import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type FlagPart = [string, Record<string, string | number>];
const window: { CodeFlareUI?: {
  translate: (text: string, language: string) => string;
  flags: Record<string, { viewBox: string; parts: FlagPart[] }>;
  nativeNames: Record<string, string>;
  languages: string[];
} } = {};
runInNewContext(readFileSync('media/ui.js', 'utf8'), { window });
const translate = window.CodeFlareUI!.translate;

describe('header language flags', () => {
  const ui = window.CodeFlareUI!;

  it('has exactly one flag per supported language', () => {
    expect(Object.keys(ui.flags).sort()).toEqual([...ui.languages].sort());
    expect(ui.languages).toEqual(['en', 'nl', 'fr', 'de']);
  });

  it('labels each flag in its OWN language, readable whatever language is active', () => {
    expect(ui.nativeNames).toEqual({ en: 'English', nl: 'Nederlands', fr: 'Français', de: 'Deutsch' });
  });

  it('draws flags from plain shapes only (no emoji, no markup strings)', () => {
    for (const [code, flag] of Object.entries(ui.flags)) {
      expect(flag.viewBox, code).toMatch(/^0 0 \d+ \d+$/);
      expect(flag.parts.length, code).toBeGreaterThan(0);
      for (const [tag, attrs] of flag.parts) {
        expect(['rect', 'path'], `${code}:${tag}`).toContain(tag);
        for (const value of Object.values(attrs)) { expect(String(value)).not.toMatch(/[<>]/); }
      }
    }
    // The tricolours use the recognisable national colours.
    const fills = (code: string) => ui.flags[code].parts.map(([, a]) => a.fill);
    expect(fills('nl')).toEqual(['#AE1C28', '#FFFFFF', '#21468B']);
    expect(fills('de')).toEqual(['#000000', '#DD0000', '#FFCE00']);
    expect(fills('fr')).toEqual(['#0055A4', '#FFFFFF', '#EF4135']);
  });
});

describe('webview localization', () => {
  it('supports all four requested languages with an English fallback', () => {
    expect(['en', 'nl', 'fr', 'de', 'unknown'].map(language => translate('Settings', language)))
      .toEqual(['Settings', 'Instellingen', 'Réglages', 'Einstellungen', 'Settings']);
  });
  it('localizes live progress without losing counts', () => {
    expect(translate('37% klaar', 'en')).toBe('37% complete');
    expect(translate('4 / 12 agents actief', 'de')).toBe('4 / 12 Agenten aktiv');
    expect(translate('Agents (3) en geschiedenis (7)', 'fr')).toBe('Agents (3) et historique (7)');
  });
  it('leaves unrecognized content and code intact', () => {
    const content = '<script>alert("Settings")</script> const x = 37;';
    expect(translate(content, 'nl')).toBe(content);
  });
  it('keeps project names and counts intact in memory summaries', () => {
    expect(translate('This project (my-app): 12 skill(s), 4 recorded experiment(s).', 'nl'))
      .toBe('Dit project (my-app): 12 vaardigheden, 4 opgeslagen experimenten.');
    expect(translate('Agent memory (shared by all projects): 9 skill(s).', 'de'))
      .toBe('Agentenspeicher (projektübergreifend): 9 Fähigkeiten.');
  });
});
