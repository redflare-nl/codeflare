import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as dns from 'dns';
import { promisify } from 'util';
import { log } from './logger';

/**
 * Screenshot an EXTERNAL web page by driving the system browser (Edge/Chrome/
 * Chromium) headless — no Playwright install needed. Ported from the user's
 * crawl_proxy.py: it presents a NORMAL browser User-Agent (headless Chrome
 * otherwise advertises "HeadlessChrome" and bot-protected sites serve a denial
 * page instead of the real one), does a DNS pre-check (so a typo photographs the
 * browser's own error page rather than the site), waits for content via
 * --virtual-time-budget, and falls back from --headless=new to --headless for
 * older browsers. Best-effort: some WAFs (Cloudflare/Akamai) still block
 * automation, in which case the captured PNG is the challenge/denied page.
 */

const isWin = process.platform === 'win32';
const lookup = promisify(dns.lookup);

// A real, current desktop Chrome UA — NOT "HeadlessChrome".
const REAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const BROWSER_CANDIDATES = isWin
  ? [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]
  : [
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
      '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];

const PATH_NAMES = isWin
  ? ['msedge.exe', 'chrome.exe']
  : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];

async function exists(p: string): Promise<boolean> {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

async function onPath(name: string): Promise<string | undefined> {
  for (const dir of (process.env.PATH || '').split(isWin ? ';' : ':')) {
    if (!dir) { continue; }
    const full = path.join(dir, name);
    if (await exists(full)) { return full; }
  }
  return undefined;
}

/** Locate an installed Edge/Chrome/Chromium binary, or undefined. */
export async function findBrowser(): Promise<string | undefined> {
  for (const c of BROWSER_CANDIDATES) { if (await exists(c)) { return c; } }
  for (const n of PATH_NAMES) { const f = await onPath(n); if (f) { return f; } }
  return undefined;
}

export interface ShotResult { ok: boolean; bytes?: number; error?: string; browser?: string; }

/** Capture `url` to `outPath` (absolute .png). Never throws — returns a result. */
export async function screenshotUrl(
  url: string,
  outPath: string,
  opts?: { width?: number; height?: number; waitMs?: number }
): Promise<ShotResult> {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, error: 'Provide an absolute http(s) URL.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'Provide an absolute http(s) URL.' };
  }

  // DNS pre-check: otherwise a bad host just photographs the browser error page.
  try { await lookup(u.hostname); }
  catch { return { ok: false, error: `DNS lookup failed for "${u.hostname}" — likely a typo in the URL.` }; }

  const browser = await findBrowser();
  if (!browser) {
    return {
      ok: false,
      error: 'No Edge/Chrome/Chromium found to render the page. Install one (or, for a LOCAL page you ' +
        'are serving, use "npx playwright screenshot").',
    };
  }

  const width = opts?.width ?? 1280;
  const height = opts?.height ?? 800;
  const budget = opts?.waitMs ?? 10000;
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cf-shot-'));

  const flags = (headless: string): string[] => [
    headless,
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${width},${height}`,
    // Own profile dir so it never clashes with an already-open Edge/Chrome.
    `--user-data-dir=${path.join(tmp, 'profile')}`,
    `--screenshot=${outPath}`,
    `--virtual-time-budget=${budget}`,
    `--user-agent=${REAL_UA}`,
    ...(isWin ? [] : ['--no-sandbox']),   // required for chromium as root / in containers
    url,
  ];

  const run = (args: string[]): Promise<void> => new Promise(resolve => {
    const child = spawn(browser, args, { stdio: 'ignore' });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(); }, 60000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
    child.on('error', () => { clearTimeout(timer); resolve(); });
  });

  try {
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    try { await fs.promises.rm(outPath, { force: true }); } catch { /* ignore */ }
    await run(flags('--headless=new'));
    if (!(await exists(outPath))) { await run(flags('--headless')); }  // older Edge/Chrome
    if (!(await exists(outPath))) {
      return { ok: false, error: 'The browser produced no screenshot (page unreachable, blocked, or the browser is too old).', browser };
    }
    const st = await fs.promises.stat(outPath);
    log(`webshot: captured ${url} → ${outPath} (${st.size} bytes)`);
    return { ok: true, bytes: st.size, browser };
  } catch (e: any) {
    return { ok: false, error: `Screenshot failed: ${e?.message || e}`, browser };
  } finally {
    fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => { /* best effort */ });
  }
}

export interface RenderResult { ok: boolean; html?: string; error?: string; browser?: string; }

/**
 * Load `url` in the real headless browser (JS executed) and return the RENDERED
 * DOM as HTML via Chrome/Edge --dump-dom. Use this when a plain fetch returns a
 * JS shell (news sites, SPAs) or is bot-blocked. Never throws.
 */
export async function renderPageHtml(url: string, opts?: { waitMs?: number }): Promise<RenderResult> {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, error: 'Provide an absolute http(s) URL.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'Provide an absolute http(s) URL.' };
  }
  try { await lookup(u.hostname); }
  catch { return { ok: false, error: `DNS lookup failed for "${u.hostname}" — likely a typo in the URL.` }; }

  const browser = await findBrowser();
  if (!browser) { return { ok: false, error: 'No Edge/Chrome/Chromium found to render the page.' }; }

  const budget = opts?.waitMs ?? 10000;
  const MAX = 8 * 1024 * 1024;   // cap the captured DOM
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cf-dom-'));

  const run = (headless: string): Promise<string> => new Promise(resolve => {
    const args = [
      headless, '--disable-gpu', '--dump-dom',
      `--user-data-dir=${path.join(tmp, 'profile')}`,
      `--virtual-time-budget=${budget}`,
      `--user-agent=${REAL_UA}`,
      ...(isWin ? [] : ['--no-sandbox']),
      url,
    ];
    const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    let size = 0;
    child.stdout.on('data', (d: Buffer) => { size += d.length; if (size <= MAX) { out += d.toString('utf8'); } });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(out); }, 60000);
    child.on('exit', () => { clearTimeout(timer); resolve(out); });
    child.on('error', () => { clearTimeout(timer); resolve(out); });
  });

  try {
    let html = await run('--headless=new');
    if (html.trim().length < 200) { html = (await run('--headless')) || html; }   // older browsers
    if (html.trim().length < 50) {
      return { ok: false, error: 'The browser returned no DOM (page unreachable or blocked).', browser };
    }
    log(`webshot: rendered DOM of ${url} (${html.length} chars)`);
    return { ok: true, html, browser };
  } finally {
    fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => { /* best effort */ });
  }
}
