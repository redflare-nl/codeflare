import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveExecutableRoot } from '../src/utils/executables';

/**
 * resolveExecutableRoot against a REAL directory tree, mirroring how Blender is
 * actually installed on Windows: a versioned folder under a vendor folder, with
 * the executable inside it. The three accepted shapes are what a user types.
 */

const isWin = process.platform === 'win32';
const EXE = isWin ? 'blender.exe' : 'blender';

let tmp: string;
let vendor: string;   // …/Blender Foundation
let install: string;  // …/Blender Foundation/Blender 5.1
let exePath: string;

beforeAll(() => {
  // A space in the path is deliberate: "Program Files" is the real-world case.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf exe '));
  vendor = path.join(tmp, 'Blender Foundation');
  install = path.join(vendor, 'Blender 5.1');
  fs.mkdirSync(install, { recursive: true });
  exePath = path.join(install, EXE);
  fs.writeFileSync(exePath, '');
});

afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('resolveExecutableRoot', () => {
  it('accepts the executable itself', async () => {
    expect(await resolveExecutableRoot(exePath, 'blender')).toBe(exePath);
  });

  it('accepts the install folder', async () => {
    expect(await resolveExecutableRoot(install, 'blender')).toBe(exePath);
  });

  it('accepts the vendor parent and descends one versioned level', async () => {
    expect(await resolveExecutableRoot(vendor, 'blender')).toBe(exePath);
  });

  it('strips surrounding quotes and whitespace', async () => {
    expect(await resolveExecutableRoot(`  "${install}"  `, 'blender')).toBe(exePath);
  });

  it('returns undefined for an empty setting', async () => {
    expect(await resolveExecutableRoot('', 'blender')).toBeUndefined();
    expect(await resolveExecutableRoot('   ', 'blender')).toBeUndefined();
  });

  it('returns undefined when the path has no such executable', async () => {
    expect(await resolveExecutableRoot(tmp, 'blender')).toBeUndefined();
    expect(await resolveExecutableRoot(path.join(tmp, 'nope'), 'blender')).toBeUndefined();
  });

  it('does not match an unrelated binary that merely shares the prefix', async () => {
    const dir = path.join(tmp, 'decoy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, isWin ? 'blender-payload.exe' : 'blender-payload'), '');
    expect(await resolveExecutableRoot(dir, 'blender')).toBeUndefined();
  });

  it('picks the newest version when several are installed', async () => {
    const older = path.join(vendor, 'Blender 4.2');
    fs.mkdirSync(older, { recursive: true });
    fs.writeFileSync(path.join(older, EXE), '');
    // Descending sort means "Blender 5.1" wins over "Blender 4.2".
    expect(await resolveExecutableRoot(vendor, 'blender')).toBe(exePath);
  });
});
