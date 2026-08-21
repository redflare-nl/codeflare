import * as zlib from 'zlib';

/**
 * Minimal pure-JS PNG pixel analyzer (uses Node's built-in zlib, no deps).
 * Used for automatic image QC: a text-only model can't SEE the sprites it
 * generates, but "97% of visible pixels are near-black" is feedback it can act
 * on. Supports 8-bit non-interlaced RGBA/RGB/gray/palette — what PIL and
 * canvas emit. Anything else returns dimensions only.
 */

export interface PngStats {
  width: number;
  height: number;
  analyzed: boolean;       // pixel data decoded successfully?
  transparentPct?: number; // fully transparent pixels (of all)
  blackPct?: number;       // near-black pixels (of the visible ones)
  distinctColors?: number; // approx. distinct color groups among visible pixels
}

export function analyzePng(bytes: Uint8Array): PngStats | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || sig.some((b, i) => bytes[i] !== b)) { return null; }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;

  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const dataStart = pos + 8;
    if (dataStart + len > bytes.length) { break; }
    if (type === 'IHDR') {
      width = dv.getUint32(dataStart);
      height = dv.getUint32(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      interlace = bytes[dataStart + 12];
    } else if (type === 'PLTE') {
      palette = bytes.slice(dataStart, dataStart + len);
    } else if (type === 'tRNS') {
      trns = bytes.slice(dataStart, dataStart + len);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(bytes.buffer, bytes.byteOffset + dataStart, len));
    } else if (type === 'IEND') {
      break;
    }
    pos = dataStart + len + 4; // skip CRC
  }

  if (!width || !height) { return null; }
  const base: PngStats = { width, height, analyzed: false };
  if (bitDepth !== 8 || interlace !== 0 || idat.length === 0) { return base; }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 3 ? 1 : 0;
  if (!channels) { return base; }

  let raw: Buffer;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return base; }

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) { return base; }

  // Undo PNG scanline filters (None/Sub/Up/Average/Paeth).
  const img = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = img.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? img.subarray((y - 1) * stride, y * stride) : undefined;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= channels && prev ? prev[x - channels] : 0;
      let v = line[x];
      switch (f) {
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
      }
      out[x] = v;
    }
  }

  // Sample up to ~20k pixels for stats.
  const total = width * height;
  const step = Math.max(1, Math.floor(total / 20000));
  let transparent = 0, black = 0, visible = 0, sampled = 0;
  const colors = new Set<number>();

  for (let i = 0; i < total; i += step) {
    sampled++;
    const o = i * channels;
    let r = 0, g = 0, b = 0, al = 255;
    if (colorType === 6) { r = img[o]; g = img[o + 1]; b = img[o + 2]; al = img[o + 3]; }
    else if (colorType === 2) { r = img[o]; g = img[o + 1]; b = img[o + 2]; }
    else if (colorType === 0) { r = g = b = img[o]; }
    else if (colorType === 3) {
      const idx = img[o];
      if (palette) { r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2]; }
      al = trns && idx < trns.length ? trns[idx] : 255;
    }
    if (al < 16) { transparent++; continue; }
    visible++;
    if (r < 24 && g < 24 && b < 24) { black++; }
    colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }

  return {
    width,
    height,
    analyzed: true,
    transparentPct: Math.round((100 * transparent) / sampled),
    blackPct: visible ? Math.round((100 * black) / visible) : 0,
    distinctColors: colors.size,
  };
}

/**
 * True when the image is almost certainly wrong. Deliberately conservative —
 * simple sprites legitimately have few colors, so only flag the sure cases:
 * essentially nothing visible, or essentially everything visible is black.
 */
export function looksBroken(s: PngStats): boolean {
  if (!s.analyzed) { return false; }
  if (s.transparentPct! >= 99) { return true; }  // fully transparent / empty
  if (s.blackPct! >= 95) { return true; }        // visible pixels are all black
  // A LARGE near-uniform image — e.g. a page screenshot that rendered blank
  // (all white or one flat color). Small images are exempt: a solid color can
  // be a legitimate tile/placeholder sprite.
  if (s.width * s.height >= 200000 && s.distinctColors! <= 2) { return true; }
  return false;
}
