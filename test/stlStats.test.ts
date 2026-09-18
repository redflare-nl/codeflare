import { describe, it, expect } from 'vitest';
import { analyzeStl, meshProblems, describeStl, StlStats } from '../src/utils/stlStats';

/**
 * Fixtures are built here rather than committed as files, so the expected
 * geometry is visible in the test. The shapes and numbers were cross-checked
 * against STLs exported by a real Blender 5.1.1 (a 2x2x2 cube exports as 12
 * triangles / 8 distinct vertices; an empty export is an 84-byte header).
 */

function binaryStl(tris: number[][]): Uint8Array {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write('CodeFlare test fixture', 0);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    const off = 84 + i * 50;
    for (let j = 0; j < 3; j++) { buf.writeFloatLE(0, off + j * 4); } // normal
    t.forEach((v, j) => buf.writeFloatLE(v, off + 12 + j * 4));
  });
  return new Uint8Array(buf);
}

/** The 12 triangles of an axis-aligned cube from (0,0,0) to (s,s,s). */
function cubeTris(s = 2): number[][] {
  const v = [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
    [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
  ];
  const quads: number[][] = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ];
  const tris: number[][] = [];
  for (const [a, b, c, d] of quads) {
    tris.push([...v[a], ...v[b], ...v[c]]);
    tris.push([...v[a], ...v[c], ...v[d]]);
  }
  return tris;
}

function asciiStl(tris: number[][]): Uint8Array {
  const body = tris.map(t =>
    `facet normal 0 0 0\n outer loop\n` +
    `  vertex ${t[0]} ${t[1]} ${t[2]}\n` +
    `  vertex ${t[3]} ${t[4]} ${t[5]}\n` +
    `  vertex ${t[6]} ${t[7]} ${t[8]}\n` +
    ` endloop\nendfacet\n`).join('');
  return new Uint8Array(Buffer.from(`solid test\n${body}endsolid test\n`, 'utf8'));
}

describe('analyzeStl — binary', () => {
  it('reads a cube: 12 triangles, 8 welded vertices, watertight', () => {
    const s = analyzeStl(binaryStl(cubeTris(2)))!;
    expect(s.format).toBe('binary');
    expect(s.triangles).toBe(12);
    expect(s.distinctVertices).toBe(8);
    expect(s.sizeConsistent).toBe(true);
    expect(s.bbox).toEqual({ x: 2, y: 2, z: 2 });
    expect(s.watertight).toBe(true);
    expect(s.nonManifoldEdges).toBe(0);
    expect(s.degenerate).toBe(0);
    expect(meshProblems(s)).toEqual([]);
  });

  it('flags an empty export — the 84-byte file a real Blender run produces', () => {
    const s = analyzeStl(binaryStl([]))!;
    expect(s.triangles).toBe(0);
    expect(s.bbox).toEqual({ x: 0, y: 0, z: 0 });
    expect(meshProblems(s)).toEqual([
      'the mesh is EMPTY (0 triangles) — nothing was exported',
    ]);
  });

  it('reports an open mesh as not watertight without calling it broken', () => {
    // Two triangles forming a square plane: 4 boundary edges, shared by one face.
    const s = analyzeStl(binaryStl([
      [0, 0, 0, 1, 0, 0, 1, 1, 0],
      [0, 0, 0, 1, 1, 0, 0, 1, 0],
    ]))!;
    expect(s.triangles).toBe(2);
    expect(s.watertight).toBe(false);
    expect(s.nonManifoldEdges).toBe(4);
    // Open is a fact to report, not a failure to interrupt the turn for.
    expect(meshProblems(s)).toEqual([]);
  });

  it('detects truncation and reports what it could read', () => {
    const full = binaryStl(cubeTris(2));
    const cut = full.subarray(0, 84 + 5 * 50); // header claims 12, only 5 present
    const s = analyzeStl(cut)!;
    expect(s.triangles).toBe(5);
    expect(s.truncated).toBe(true);
    expect(s.sizeConsistent).toBe(false);
    expect(meshProblems(s)).toContain('the file is TRUNCATED — the export was cut off mid-write');
  });

  it('flags a header/size mismatch that is not mere truncation', () => {
    const buf = Buffer.from(binaryStl(cubeTris(2)));
    buf.writeUInt32LE(3, 80); // claims 3, file holds 12
    const s = analyzeStl(new Uint8Array(buf))!;
    expect(s.sizeConsistent).toBe(false);
    expect(s.truncated).toBeUndefined();
    expect(meshProblems(s).join()).toMatch(/does not match the file size/);
  });

  it('flags geometry collapsed to a point', () => {
    const s = analyzeStl(binaryStl([[1, 1, 1, 1, 1, 1, 1, 1, 1]]))!;
    expect(s.bbox).toEqual({ x: 0, y: 0, z: 0 });
    expect(meshProblems(s).join()).toMatch(/collapsed to a point/);
  });

  it('flags a mesh with extent in only one axis', () => {
    const s = analyzeStl(binaryStl([[0, 0, 0, 1, 0, 0, 2, 0, 0]]))!;
    expect(meshProblems(s).join()).toMatch(/no extent in two or more axes/);
  });

  it('flags an all-degenerate surface', () => {
    // Collinear points in two axes: non-zero bbox, but zero area.
    const s = analyzeStl(binaryStl([
      [0, 0, 0, 1, 1, 0, 2, 2, 0],
      [0, 0, 0, 2, 2, 0, 3, 3, 0],
    ]))!;
    expect(s.degenerate).toBe(2);
    expect(meshProblems(s).join()).toMatch(/zero-area/);
  });

  it('scales the degeneracy tolerance to the model size (millimetre parts)', () => {
    // A 5mm triangle expressed in metres — tiny absolute area, valid geometry.
    const s = analyzeStl(binaryStl([[0, 0, 0, 0.005, 0, 0, 0, 0.005, 0]]))!;
    expect(s.degenerate).toBe(0);
  });

  it('welds mirrored vertices so -0 and 0 are the same position', () => {
    const s = analyzeStl(binaryStl([
      [0, 0, 0, 1, 0, 0, 0, 1, 0],
      [-0, -0, -0, 1, 0, 0, 0, -1, 0],
    ]))!;
    expect(s.distinctVertices).toBe(4); // (0,0,0) shared, not counted twice
  });
});

describe('analyzeStl — ascii', () => {
  it('reads an ascii cube identically to the binary one', () => {
    const s = analyzeStl(asciiStl(cubeTris(2)))!;
    expect(s.format).toBe('ascii');
    expect(s.triangles).toBe(12);
    expect(s.distinctVertices).toBe(8);
    expect(s.watertight).toBe(true);
    expect(s.bbox).toEqual({ x: 2, y: 2, z: 2 });
  });

  it('flags an ascii file cut off mid-facet', () => {
    const full = Buffer.from(asciiStl(cubeTris(2))).toString('utf8');
    const cut = full.slice(0, full.indexOf('vertex') + 'vertex 0 0 0\n  vertex 2 0 0\n'.length);
    const s = analyzeStl(new Uint8Array(Buffer.from(cut, 'utf8')))!;
    expect(s.truncated).toBe(true);
  });

  it('reports an empty ascii solid as empty', () => {
    const s = analyzeStl(new Uint8Array(Buffer.from('solid empty\nendsolid empty\n', 'utf8')))!;
    expect(s.triangles).toBe(0);
    expect(meshProblems(s).join()).toMatch(/EMPTY/);
  });

  it('does not mistake a binary file whose header starts with "solid"', () => {
    const buf = Buffer.from(binaryStl(cubeTris(2)));
    buf.write('solid exported by some writer', 0);
    const s = analyzeStl(new Uint8Array(buf))!;
    expect(s.format).toBe('binary');
    expect(s.triangles).toBe(12);
  });
});

describe('analyzeStl — rejects non-STL input', () => {
  it('returns null for empty or tiny input', () => {
    expect(analyzeStl(new Uint8Array(0))).toBeNull();
    expect(analyzeStl(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('returns null for binary junk too short to hold a header', () => {
    expect(analyzeStl(new Uint8Array(Buffer.alloc(50, 0xff)))).toBeNull();
  });
});

describe('describeStl', () => {
  it('summarises a healthy mesh', () => {
    const s = analyzeStl(binaryStl(cubeTris(2)))!;
    expect(describeStl(s)).toBe(
      'binary STL — 12 triangles, 8 distinct vertices, bbox 2x2x2, watertight');
  });

  it('names the defects it found', () => {
    const s: StlStats = {
      format: 'binary', triangles: 2, bbox: { x: 1, y: 1, z: 0 },
      degenerate: 1, distinctVertices: 4, watertight: false, nonManifoldEdges: 4,
    };
    const d = describeStl(s);
    expect(d).toMatch(/NOT watertight \(4 non-manifold edge\(s\)\)/);
    expect(d).toMatch(/1 degenerate face\(s\)/);
  });

  it('keeps millimetre-scale dimensions readable', () => {
    const s: StlStats = {
      format: 'binary', triangles: 1, bbox: { x: 0.04, y: 0.02, z: 0.005 },
      degenerate: 0, distinctVertices: 3,
    };
    expect(describeStl(s)).toMatch(/bbox 0\.04x0\.02x0\.005/);
  });
});
