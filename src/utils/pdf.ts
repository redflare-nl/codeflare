import * as path from 'path';
import { pathToFileURL } from 'url';

/**
 * Extracts plain text from a PDF using pdf.js (pdfjs-dist v4 legacy build,
 * vendored under vendor/pdfjs/). It runs in the extension host — no network,
 * no native modules. v4's legacy build has a pure-JS fallback for DOMMatrix,
 * so it works cross-platform without @napi-rs/canvas (which v6 requires).
 *
 * The .mjs is loaded at runtime (not bundled) so its Node polyfills stay
 * intact; esbuild bundling to CJS breaks them.
 */

export interface PdfText {
  text: string;
  pages: number;
  truncated: boolean;
}

let pdfjsPromise: Promise<any> | undefined;

function loadPdfjs(extensionPath: string): Promise<any> {
  if (!pdfjsPromise) {
    const file = path.join(extensionPath, 'vendor', 'pdfjs', 'pdf.mjs');
    // Clear the cache if the import rejects, so one transient failure (e.g. the
    // vendor file momentarily locked during a VSIX reinstall) doesn't leave every
    // later PDF read rejecting with the same stale error until a window reload.
    pdfjsPromise = import(pathToFileURL(file).href).catch(err => {
      pdfjsPromise = undefined;
      throw err;
    });
  }
  return pdfjsPromise;
}

export async function extractPdfText(
  data: Uint8Array,
  extensionPath: string,
  maxChars = 200000
): Promise<PdfText> {
  const pdfjs = await loadPdfjs(extensionPath);

  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
  }).promise;

  const pages = doc.numPages;
  const parts: string[] = [];
  let truncated = false;

  try {
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((it: any) => (typeof it.str === 'string' ? it.str : ''))
        .join(' ')
        .replace(/[ \t]+/g, ' ')
        .trim();
      parts.push(pageText);

      if (parts.join('\n\n').length > maxChars) { truncated = true; break; }
    }
  } finally {
    // destroy() (not just cleanup()) terminates the worker/transport and frees
    // the whole document — cleanup() alone keeps it referenced, leaking a decoded
    // PDF per read. In a finally so a throw on a corrupt page still releases it.
    try { await doc.destroy(); } catch { /* ignore */ }
  }

  let text = parts.join('\n\n');
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  if (truncated) { text += '\n… (truncated)'; }

  return { text, pages, truncated };
}
