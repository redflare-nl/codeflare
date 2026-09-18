/**
 * Pure STL mesh analyzer (no deps) — the pngStats.ts of 3D output.
 *
 * A text-only model cannot SEE the mesh it just generated, and unlike a sprite a
 * mesh can't be judged by looking at pixels either. But an STL is a trivial
 * format, so real geometric properties can be computed and handed back as text:
 * "0 triangles" or "1,284 non-manifold edges" is feedback a model can act on.
 *
 * This yields evidence that is STRONGER than a render: watertightness is a
 * proven property of the geometry, not an impression of a picture.
 *
 * Binary STL:  80-byte header, uint32 triangle count, then 50 bytes per triangle
 *              (3 floats normal + 3x3 floats vertices + uint16 attribute count).
 * ASCII STL:   "solid <name> … facet normal … outer loop … vertex x y z … endsolid".
 */

export interface StlStats {
  format: 'binary' | 'ascii';
  triangles: number;
  /** Binary only: header count matched the actual file length. */
  sizeConsistent?: boolean;
  /** Axis-aligned bounding box size, in the file's own units. */
  bbox: { x: number; y: number; z: number };
  /** Zero-area faces — never printable, usually a modelling mistake. */
  degenerate: number;
  /** Distinct vertex positions (welded at 1e-6) — a cube is 8, not 36. */
  distinctVertices: number;
  /**
   * Every edge shared by exactly two triangles = a closed surface. Undefined
   * when the mesh was too large to check exhaustively (see EDGE_CHECK_LIMIT).
   */
  watertight?: boolean;
  /** Edges NOT shared by exactly two triangles, when watertight was computed. */
  nonManifoldEdges?: number;
  /** Set when parsing stopped early; the other numbers then describe what was read. */
  truncated?: boolean;
}

// Edge bookkeeping is the only part that grows memory with mesh size. Meshes
// above this trade watertightness for a bounded check — the cheap signals
// (count, bbox, degenerates) still come back.
const EDGE_CHECK_LIMIT = 400_000;

/** Weld tolerance for vertex identity: STL stores float32, so exact compare is wrong. */
const QUANT = 1e6;

function keyOf(x: number, y: number, z: number): string {
  // Round to 1e-6 and normalise -0 to 0 so mirrored geometry welds correctly.
  const q = (v: number) => (Math.round(v * QUANT) / QUANT) + 0;
  return `${q(x)},${q(y)},${q(z)}`;
}

function triangleArea(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number
): number {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
}

/** Accumulates per-triangle geometry into the reported statistics. */
class MeshAccumulator {
  private min = [Infinity, Infinity, Infinity];
  private max = [-Infinity, -Infinity, -Infinity];
  private verts = new Set<string>();
  private edges = new Map<string, number>();
  private edgesGivenUp = false;
  degenerate = 0;
  triangles = 0;

  add(v: number[]): void {
    this.triangles++;
    for (let i = 0; i < 3; i++) {
      const x = v[i * 3], y = v[i * 3 + 1], z = v[i * 3 + 2];
      if (x < this.min[0]) { this.min[0] = x; }
      if (y < this.min[1]) { this.min[1] = y; }
      if (z < this.min[2]) { this.min[2] = z; }
      if (x > this.max[0]) { this.max[0] = x; }
      if (y > this.max[1]) { this.max[1] = y; }
      if (z > this.max[2]) { this.max[2] = z; }
    }

    // A zero-area face has no normal and cannot be printed. Scale the tolerance
    // to the model: an absolute epsilon would flag every face of a millimetre-
    // scale part (Blender's default unit is the metre) as degenerate.
    const area = triangleArea(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]);
    const span = Math.max(
      this.max[0] - this.min[0], this.max[1] - this.min[1], this.max[2] - this.min[2], 1e-9);
    if (area <= span * span * 1e-12) { this.degenerate++; }

    const k = [
      keyOf(v[0], v[1], v[2]),
      keyOf(v[3], v[4], v[5]),
      keyOf(v[6], v[7], v[8]),
    ];
    for (const kk of k) { this.verts.add(kk); }

    if (this.edgesGivenUp) { return; }
    if (this.edges.size > EDGE_CHECK_LIMIT * 3) { this.edges.clear(); this.edgesGivenUp = true; return; }
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      // Undirected edge: sort the endpoints so both winding orders collide.
      const e = k[a] < k[b] ? `${k[a]}|${k[b]}` : `${k[b]}|${k[a]}`;
      this.edges.set(e, (this.edges.get(e) || 0) + 1);
    }
  }

  finish(format: 'binary' | 'ascii', extra: Partial<StlStats>): StlStats {
    const size = (i: number) =>
      this.triangles === 0 ? 0 : Math.max(0, this.max[i] - this.min[i]);
    const stats: StlStats = {
      format,
      triangles: this.triangles,
      bbox: { x: size(0), y: size(1), z: size(2) },
      degenerate: this.degenerate,
      distinctVertices: this.verts.size,
      ...extra,
    };
    if (!this.edgesGivenUp && this.triangles > 0) {
      let bad = 0;
      for (const c of this.edges.values()) { if (c !== 2) { bad++; } }
      stats.watertight = bad === 0;
      stats.nonManifoldEdges = bad;
    }
    return stats;
  }
}

function looksAscii(bytes: Uint8Array): boolean {
  // "solid" alone is not decisive: some binary writers put it in the header.
  // The reliable discriminator is whether the declared triangle count matches
  // the file length exactly, so prefer that when the file is long enough.
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 512)).toLowerCase();
  if (!/^\s*solid/.test(head)) { return false; }
  if (bytes.length >= 84) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === bytes.length) { return false; }
  }
  return /facet\s+normal|outer\s+loop/.test(head) || bytes.length < 84;
}

function parseAscii(bytes: Uint8Array): StlStats {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const acc = new MeshAccumulator();
  const re = /vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g;
  let m: RegExpExecArray | null;
  let buf: number[] = [];
  while ((m = re.exec(text)) !== null) {
    buf.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
    if (buf.length === 9) { acc.add(buf); buf = []; }
  }
  // A trailing partial facet means the file was cut off mid-write.
  return acc.finish('ascii', buf.length > 0 ? { truncated: true } : {});
}

function parseBinary(bytes: Uint8Array): StlStats {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = dv.getUint32(80, true);
  const sizeConsistent = 84 + declared * 50 === bytes.length;
  // Trust the file length over the header: a truncated export declares the
  // count it intended to write, and reading past the end would throw.
  const available = Math.max(0, Math.floor((bytes.length - 84) / 50));
  const n = Math.min(declared, available);

  const acc = new MeshAccumulator();
  const v = new Array<number>(9);
  for (let i = 0; i < n; i++) {
    const off = 84 + i * 50 + 12; // skip the stored normal; we derive our own
    for (let j = 0; j < 9; j++) { v[j] = dv.getFloat32(off + j * 4, true); }
    acc.add(v);
  }
  return acc.finish('binary', {
    sizeConsistent,
    ...(n < declared ? { truncated: true } : {}),
  });
}

/** Parse an STL. Returns null when the bytes are not a usable STL at all. */
export function analyzeStl(bytes: Uint8Array): StlStats | null {
  if (!bytes || bytes.length < 15) { return null; }
  if (looksAscii(bytes)) {
    const s = parseAscii(bytes);
    // "solid" with no vertices at all is either an empty export or not an STL;
    // an empty export is exactly what the gate must report, so keep it.
    return s;
  }
  if (bytes.length < 84) { return null; }
  return parseBinary(bytes);
}

/**
 * Problems worth interrupting the turn for. Deliberately conservative: only
 * things that are unambiguously wrong, never matters of taste. A mesh that is
 * merely open (a plane, a surface patch) is NOT broken — but the model should
 * know, so open-ness is reported by describeStl instead of flagged here.
 */
export function meshProblems(s: StlStats): string[] {
  const out: string[] = [];
  if (s.triangles === 0) {
    out.push('the mesh is EMPTY (0 triangles) — nothing was exported');
    return out; // Everything else is meaningless for an empty mesh.
  }
  if (s.truncated) {
    out.push('the file is TRUNCATED — the export was cut off mid-write');
  }
  if (s.format === 'binary' && s.sizeConsistent === false && !s.truncated) {
    out.push('the triangle count in the header does not match the file size — the file is malformed');
  }
  const { x, y, z } = s.bbox;
  if (x === 0 && y === 0 && z === 0) {
    out.push('every vertex is at the same position — the geometry collapsed to a point');
  } else if ([x, y, z].filter(d => d === 0).length >= 2) {
    out.push('the mesh is degenerate: it has no extent in two or more axes (a line, not a solid)');
  }
  if (s.degenerate > 0 && s.degenerate === s.triangles) {
    out.push(`all ${s.triangles} faces are zero-area — there is no printable surface`);
  }
  return out;
}

/** One-line human/model-readable summary. Units are whatever the file uses. */
export function describeStl(s: StlStats): string {
  const r = (v: number) => (Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.001)
    ? v.toExponential(3) : Number(v.toFixed(4)).toString());
  const parts = [
    `${s.triangles} triangles`,
    `${s.distinctVertices} distinct vertices`,
    `bbox ${r(s.bbox.x)}x${r(s.bbox.y)}x${r(s.bbox.z)}`,
  ];
  if (s.watertight === true) { parts.push('watertight'); }
  else if (s.watertight === false) { parts.push(`NOT watertight (${s.nonManifoldEdges} non-manifold edge(s))`); }
  if (s.degenerate > 0) { parts.push(`${s.degenerate} degenerate face(s)`); }
  if (s.truncated) { parts.push('TRUNCATED'); }
  return `${s.format} STL — ${parts.join(', ')}`;
}
