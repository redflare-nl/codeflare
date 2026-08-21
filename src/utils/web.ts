/**
 * Read-only web access for the agent: fetch a page as text, run a web search
 * (DuckDuckGo HTML endpoint, no API key), or extract structured data (links /
 * images / emails) from a page. Best-effort — may be rate-limited or blocked
 * behind a firewall, in which case a clear message is returned.
 */

// A real, current desktop Chrome UA — many sites serve a block/challenge page to
// an obvious bot UA, so present a normal browser (same idea as the screenshot path).
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** DuckDuckGo wraps result links as /l/?uddg=<encoded>. Unwrap them. */
function unwrapDdgLink(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* fall through */ }
  }
  return href.startsWith('//') ? 'https:' + href : href;
}

export async function webFetch(url: string, maxChars = 20000): Promise<string> {
  if (!/^https?:\/\//i.test(url)) {
    return 'URL must start with http:// or https://';
  }
  let resp: Response;
  try {
    resp = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': BROWSER_UA },
    });
  } catch (err: any) {
    return `Could not fetch ${url}: ${err.message} (offline or blocked?)`;
  }
  if (!resp.ok) { return `HTTP ${resp.status} fetching ${url}`; }

  const contentType = resp.headers.get('content-type') || '';
  let body = await resp.text();
  if (contentType.includes('html') || /^\s*</.test(body)) {
    body = stripTags(body);
  }
  if (body.length > maxChars) {
    body = body.slice(0, maxChars) + '\n… (truncated)';
  }
  return body.trim() || '(empty response)';
}

export async function webSearch(query: string, max = 6): Promise<string> {
  if (!query.trim()) { return 'Empty search query.'; }
  let html: string;
  try {
    const resp = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CodeFlare)' },
    });
    if (!resp.ok) { return `Search failed: HTTP ${resp.status}`; }
    html = await resp.text();
  } catch (err: any) {
    return `Search failed: ${err.message} (offline or blocked?)`;
  }

  const results: string[] = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i;
  // Collect the result links with their positions, then pair each with a snippet
  // found only WITHIN that link's own segment (up to the next link). Scanning
  // links and snippets independently and pairing by index (the old approach)
  // shifted every snippet onto the wrong title as soon as one result — an ad
  // row, a module — had a link but no snippet.
  const links: { end: number; index: number; href: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    links.push({ end: linkRe.lastIndex, index: m.index, href: m[1], title: stripTags(m[2]) });
  }
  for (let k = 0; k < links.length && results.length < max; k++) {
    const seg = html.slice(links[k].end, k + 1 < links.length ? links[k + 1].index : undefined);
    const sm = snippetRe.exec(seg);
    const snippet = sm ? `\n   ${stripTags(sm[1]).slice(0, 200)}` : '';
    results.push(`${links[k].title}\n   ${unwrapDdgLink(links[k].href)}${snippet}`);
  }

  if (results.length === 0) { return `No results for "${query}" (search may be blocked).`; }
  return `Search results for "${query}":\n\n${results.join('\n\n')}`;
}

// ── Structured extraction (crawl/harvest) ────────────────────────────

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x2f;/gi, '/');
}

export interface ExtractResult {
  title: string;
  links: { url: string; text: string }[];
  images: string[];
  emails: string[];
}

/**
 * Pull the links (absolute URL + anchor text), images and email addresses out of
 * an HTML document, resolving relative URLs against `baseUrl`. Pure string work
 * (no DOM); ported from the user's crawl_proxy.py extract_from_html.
 */
export function extractFromHtml(html: string, baseUrl: string): ExtractResult {
  const abs = (href: string): string | null => {
    try {
      const u = new URL(decodeEntities(href.trim()), baseUrl);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch { return null; }
  };

  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '')
    .replace(/\s+/g, ' ').trim());

  const links: { url: string; text: string }[] = [];
  const lseen = new Set<string>();
  const aRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(html)) !== null) {
    const url = abs(m[1]);
    if (!url || lseen.has(url)) { continue; }
    lseen.add(url);
    links.push({ url, text: stripTags(m[2]).replace(/\s+/g, ' ').trim().slice(0, 120) });
  }

  const images: string[] = [];
  const iseen = new Set<string>();
  const addImg = (raw: string) => {
    const url = abs(raw);
    if (url && !url.startsWith('data:') && !iseen.has(url)) { iseen.add(url); images.push(url); }
  };
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    for (const mm of tag.matchAll(/\b(?:src|data-src|data-original)\s*=\s*["']([^"']+)["']/gi)) { addImg(mm[1]); }
    const ss = /\bsrcset\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (ss) { for (const cand of ss[1].split(',')) { addImg(cand.trim().split(/\s+/)[0]); } }
  }

  const emails = new Set<string>();
  for (const e of decodeEntities(html).match(EMAIL_RE) || []) { emails.add(e.toLowerCase()); }
  for (const mm of html.matchAll(/href\s*=\s*["']mailto:([^"'?]+)/gi)) {
    const e = decodeEntities(mm[1]).trim().toLowerCase();
    if (e.includes('@')) { emails.add(e); }
  }

  return { title, links, images, emails: [...emails] };
}

// ── Multi-page crawl (breadth-first, with loop detection + a page cap) ──

export interface CrawlPage { url: string; title: string; ok: boolean; note?: string; }
export interface CrawlResult {
  pages: CrawlPage[];
  links: string[];
  emails: string[];
  stoppedReason: 'limit' | 'exhausted' | 'time';
}

/** Normalize a URL for loop detection: absolute, drop the #fragment (same page). */
function normUrl(u: string): string | null {
  try { const x = new URL(u); x.hash = ''; return x.href; } catch { return null; }
}

// A crawl NEVER visits more than this many pages, whatever max_pages says.
const CRAWL_HARD_CAP = 40;

/**
 * Breadth-first crawl from `startUrl`, following links via the injected
 * `getPage` (so the caller chooses fast fetch vs. a JS-rendered browser). Loop
 * detection: a page is fetched at most ONCE (visited + queued sets, fragments
 * ignored, redirect targets marked visited). Bounded by `maxPages` (default 8,
 * hard-capped), an optional same-domain filter, and a wall-clock budget.
 */
export async function crawlSite(
  startUrl: string,
  getPage: (url: string) => Promise<{ html: string; finalUrl: string }>,
  opts: { maxPages?: number; sameDomain?: boolean; budgetMs?: number; now?: () => number }
): Promise<CrawlResult> {
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 8, CRAWL_HARD_CAP));
  const sameDomain = opts.sameDomain !== false;
  const now = opts.now ?? (() => Date.now());
  const budgetMs = opts.budgetMs ?? 120000;
  const t0 = now();

  let startHost: string;
  const start = normUrl(startUrl);
  try { startHost = new URL(startUrl).hostname; } catch { return { pages: [], links: [], emails: [], stoppedReason: 'exhausted' }; }
  if (!start) { return { pages: [], links: [], emails: [], stoppedReason: 'exhausted' }; }

  const queue: string[] = [start];
  const queued = new Set<string>([start]);   // ever-enqueued (prevents re-queueing)
  const visited = new Set<string>();          // ever-fetched (loop detection)
  const pages: CrawlPage[] = [];
  const links = new Set<string>();
  const emails = new Set<string>();
  let stoppedReason: CrawlResult['stoppedReason'] = 'exhausted';

  while (queue.length) {
    if (pages.length >= maxPages) { stoppedReason = 'limit'; break; }
    if (now() - t0 > budgetMs) { stoppedReason = 'time'; break; }

    const url = queue.shift()!;
    if (visited.has(url)) { continue; }        // "been here already" — skip
    visited.add(url);

    let html: string;
    let finalUrl = url;
    try {
      const r = await getPage(url);
      html = r.html;
      finalUrl = normUrl(r.finalUrl) || url;
      if (finalUrl !== url) { visited.add(finalUrl); }   // redirect target counts as visited too
    } catch (e: any) {
      pages.push({ url, title: '', ok: false, note: String(e?.message || e).slice(0, 120) });
      continue;
    }

    const ex = extractFromHtml(html, finalUrl);
    pages.push({ url: finalUrl, title: ex.title, ok: true });
    for (const l of ex.links) { links.add(l.url); }
    for (const em of ex.emails) { emails.add(em); }

    for (const l of ex.links) {
      const nu = normUrl(l.url);
      if (!nu || visited.has(nu) || queued.has(nu)) { continue; }
      let host: string;
      try { host = new URL(nu).hostname; } catch { continue; }
      if (sameDomain && host !== startHost) { continue; }
      queued.add(nu);
      queue.push(nu);
    }
  }

  return { pages, links: [...links], emails: [...emails], stoppedReason };
}
