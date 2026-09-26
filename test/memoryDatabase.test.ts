import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { build } from 'esbuild';
import initSqlJs from 'sql.js';
import { MemoryDatabase, MEMORY_DATABASE_MAX_BYTES, MEMORY_ARTIFACT_MAX_BYTES } from '../src/engine/memoryDatabase';

let root: string;
let database: MemoryDatabase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'cf-memory-database-'));
  database = new MemoryDatabase(root);
});

afterEach(async () => {
  const target = path.resolve(root);
  if (!target.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(target).startsWith('cf-memory-database-')) {
    throw new Error('Unsafe test cleanup target');
  }
  await fs.rm(target, { recursive: true, force: true });
});

const filename = () => path.join(root, 'memory.sqlite');
const save = (key: string, value: unknown) => database.updateState(key, () => ({ value, result: undefined }));

describe('MemoryDatabase', () => {
  it('stores actual SQLite in an explicit directory and survives a new service instance', async () => {
    expect(await database.readState('knowledge')).toBeUndefined();
    expect(await database.updateState('knowledge', () => ({ value: { version: 3, facts: ['old lessons'] }, result: 'saved' }))).toBe('saved');
    expect((await fs.readFile(filename())).subarray(0, 16).toString('binary')).toBe('SQLite format 3\0');
    expect(await new MemoryDatabase(root).readState('knowledge')).toEqual({ version: 3, facts: ['old lessons'] });
    expect(() => new MemoryDatabase('relative-memory')).toThrow(/absolute/);
    await expect(fs.stat(path.join(root, 'memory.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes asynchronous state migrations and updates between service instances', async () => {
    const instances = [database, new MemoryDatabase(root), new MemoryDatabase(root)];
    let imports = 0;
    await Promise.all(Array.from({ length: 30 }, (_, index) => instances[index % 3].updateState<number, void>('counter', async value => {
      if (value === undefined) { imports++; }
      await new Promise(resolve => setTimeout(resolve, 1));
      return { value: (value ?? 0) + 1, result: undefined };
    })));
    expect(await database.readState('counter')).toBe(30);
    expect(imports).toBe(1);
  });

  it('preserves committed state after failed asynchronous updates and releases its lock', async () => {
    await save('knowledge', { lessons: ['keep'] });
    const before = await fs.readFile(filename());
    await expect(database.updateState<{ lessons: string[] }, void>('knowledge', async value => {
      value!.lessons.push('uncommitted');
      throw new Error('update failed');
    })).rejects.toThrow('update failed');
    expect(await fs.readFile(filename())).toEqual(before);
    expect(await database.readState('knowledge')).toEqual({ lessons: ['keep'] });
    await save('other', true);
    expect(await database.readState('other')).toBe(true);
  });

  it('uses its exclusive file lock across separate Node processes', async () => {
    const compiled = path.join(root, 'memory-service.cjs');
    await build({ entryPoints: [path.resolve('src/engine/memoryDatabase.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'cjs', external: ['sql.js'], logLevel: 'silent' });
    const worker = path.join(root, 'worker.cjs');
    await fs.writeFile(worker, `
      const { MemoryDatabase } = require(process.argv[2]);
      const db = new MemoryDatabase(process.argv[3]);
      (async () => {
        for (let i=0; i<12; i++) await db.updateState('counter', async count => {
          await new Promise(resolve => setTimeout(resolve, 2));
          return { value: (count || 0) + 1, result: undefined };
        });
      })().catch(error => { console.error(error); process.exitCode=1; });
    `);
    const nodePath = path.dirname(path.dirname(path.dirname(require.resolve('sql.js'))));
    const run = () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [worker, compiled, root], { windowsHide: true, env: { ...process.env, NODE_PATH: nodePath } });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.once('error', reject);
      child.once('exit', status => status === 0 ? resolve() : reject(new Error(`Worker exited ${status}: ${output}`)));
    });
    await Promise.all([run(), run(), run()]);
    expect(await database.readState('counter')).toBe(36);
  }, 20000);

  it.each([0, 2, 999])('refuses unsupported schema version %s without overwriting it', async version => {
    await save('knowledge', { important: true });
    const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
    const foreign = new SQL.Database(await fs.readFile(filename()));
    foreign.run(`PRAGMA user_version=${version}`);
    const before = Buffer.from(foreign.export());
    foreign.close();
    await fs.writeFile(filename(), before);
    await expect(save('knowledge', {})).rejects.toThrow(/Unsupported memory database schema/);
    expect(await fs.readFile(filename())).toEqual(before);
  });

  it('rejects unrelated SQLite databases even if they use version one', async () => {
    const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
    const foreign = new SQL.Database();
    foreign.run('PRAGMA user_version=1; CREATE TABLE other (value TEXT)');
    const before = Buffer.from(foreign.export());
    foreign.close();
    await fs.writeFile(filename(), before);
    await expect(save('knowledge', {})).rejects.toThrow(/Unsupported memory database schema/);
    expect(await fs.readFile(filename())).toEqual(before);
  });

  it('preserves corrupt data for recovery instead of replacing it with empty memory', async () => {
    const before = Buffer.from('broken persistent memory');
    await fs.writeFile(filename(), before);
    await expect(database.readState('knowledge')).rejects.toThrow(/Corrupt memory SQLite header/);
    await expect(save('knowledge', {})).rejects.toThrow(/Corrupt memory SQLite header/);
    expect(await fs.readFile(filename())).toEqual(before);
  });

  it('fails closed on oversized files and rejects oversized state before publication', async () => {
    await save('knowledge', { keep: true });
    const before = await fs.readFile(filename());
    await expect(save('knowledge', 'x'.repeat(8 * 1024 * 1024))).rejects.toThrow(/8 MiB/);
    expect(await fs.readFile(filename())).toEqual(before);
    await fs.writeFile(filename(), Buffer.alloc(MEMORY_DATABASE_MAX_BYTES + 1));
    await expect(database.readState('knowledge')).rejects.toThrow(/exceeds/);
  });

  it('enforces the exported database size limit without losing previous transactions', async () => {
    await save('first', 'a'.repeat(7 * 1024 * 1024));
    await save('second', 'b'.repeat(7 * 1024 * 1024));
    const before = await fs.readFile(filename());
    await expect(save('third', 'c'.repeat(7 * 1024 * 1024))).rejects.toThrow(/20 MiB/);
    expect(createHash('sha256').update(await fs.readFile(filename())).digest('hex')).toBe(createHash('sha256').update(before).digest('hex'));
    expect(await database.readState('third')).toBeUndefined();
  }, 20000);

  it('round trips parameterized keys containing SQL punctuation', async () => {
    const unusual = `knowledge'; DROP TABLE states; --`;
    await save(unusual, { value: 'still a value' });
    expect(await database.readState(unusual)).toEqual({ value: 'still a value' });
    await expect(save('', {})).rejects.toThrow(/key/);
  });
});

describe('memory vectors', () => {
  it('commits a whole vector batch and rejects invalid batches before changing any cached vector', async () => {
    await database.putVectors([
      { memoryKey: 'a', model: 'local', textHash: 'v1', vector: [1, 0] },
      { memoryKey: 'b', model: 'local', textHash: 'v1', vector: [0, 1] },
    ]);
    await expect(database.putVectors([
      { memoryKey: 'a', model: 'local', textHash: 'v2', vector: [0.5, 0.5] },
      { memoryKey: 'b', model: 'local', textHash: 'v2', vector: [NaN] },
    ])).rejects.toThrow(/finite/);
    expect((await new MemoryDatabase(root).getVectors(['a', 'b'], 'local')).map(v => v.textHash)).toEqual(['v1', 'v1']);
  });

  it('keeps model-specific vectors across restart and replaces outdated text hashes', async () => {
    await database.putVector('skill:1', 'model-a', 'hash1', [1, 0, -0.5]);
    await database.putVector('skill:1', 'model-b', 'hash1', [0.25, 0.75]);
    await database.putVector('skill:1', 'model-a', 'hash2', [0, 1, 0.5]);
    expect(await new MemoryDatabase(root).getVectors(['skill:1', 'missing', 'skill:1'], 'model-a')).toEqual([
      { memoryKey: 'skill:1', model: 'model-a', textHash: 'hash2', vector: [0, 1, 0.5] },
    ]);
    expect((await database.getVectors(['skill:1'], 'model-b'))[0].vector).toEqual([0.25, 0.75]);
    expect(await database.getVectors([], 'model-a')).toEqual([]);
  });

  it.each([[], [NaN], [Infinity], ['bad'], new Array(16385).fill(0)])('rejects invalid vector data %#', async vector => {
    await expect(database.putVector('skill:1', 'model', 'hash', vector as number[])).rejects.toThrow(/finite numbers/);
  });
});

describe('memory artifacts', () => {
  it('stores hash-addressed bytes separately from SQLite and verifies them after restart', async () => {
    const content = 'A retained experiment report: ünicode.';
    const stored = await database.putArtifact(content, 'text/plain');
    expect(stored).toEqual({ id: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content), mimeType: 'text/plain' });
    expect(Buffer.from(await new MemoryDatabase(root).readArtifact(stored.id)).toString('utf8')).toBe(content);
    expect(await fs.readdir(path.join(root, 'artifacts'))).toEqual([stored.id]);
    expect(await database.putArtifact(content, 'text/markdown')).toEqual(stored);
    expect((await fs.stat(filename())).size).toBeLessThan(100000);
  });

  it('rejects corrupted and missing artifact bytes without silently repairing them', async () => {
    const stored = await database.putArtifact(new Uint8Array([1, 2, 3]), 'application/octet-stream');
    const artifact = path.join(root, 'artifacts', stored.id);
    await fs.writeFile(artifact, new Uint8Array([1, 2, 4]));
    await expect(database.readArtifact(stored.id)).rejects.toThrow(/integrity/);
    await expect(database.putArtifact(new Uint8Array([1, 2, 3]), 'application/octet-stream')).rejects.toThrow(/integrity/);
    await fs.unlink(artifact);
    await expect(database.readArtifact(stored.id)).rejects.toThrow(/integrity/);
    await expect(database.putArtifact(new Uint8Array([1, 2, 3]), 'application/octet-stream')).rejects.toThrow(/metadata/);
  });

  it('rejects paths, unknown IDs, invalid media types, and oversized artifacts', async () => {
    await expect(database.readArtifact('../secret')).rejects.toThrow(/ID/);
    await expect(database.readArtifact('a'.repeat(64))).rejects.toThrow(/Unknown/);
    await expect(database.putArtifact('text', 'not a MIME')).rejects.toThrow(/MIME/);
    await expect(database.putArtifact(Buffer.alloc(MEMORY_ARTIFACT_MAX_BYTES + 1), 'application/octet-stream')).rejects.toThrow(/20 MiB/);
  });

  it('refuses artifact directory junctions or symlinks pointing outside storage', async () => {
    const outside = path.join(root, 'outside');
    const storage = path.join(root, 'private');
    await fs.mkdir(outside);
    await fs.mkdir(storage);
    await fs.symlink(outside, path.join(storage, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(new MemoryDatabase(storage).putArtifact('secret', 'text/plain')).rejects.toThrow(/symbolic link/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('refuses a symlinked storage root', async () => {
    const actual = path.join(root, 'actual');
    const alias = path.join(root, 'alias');
    await fs.mkdir(actual);
    await fs.symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(new MemoryDatabase(alias).readState('knowledge')).rejects.toThrow(/symbolic link/);
  });

  describe('clear', () => {
    it('erases states, embeddings and artifacts, and reports the counts', async () => {
      await save('episodes', { schemaVersion: 1, records: [{ id: 'a' }] });
      await save('knowledge', { schemaVersion: 1, skills: [], landscapes: [] });
      await database.putVectors([{ memoryKey: 'k1', model: 'm', textHash: 'h', vector: [0.5] }]);
      const artifact = await database.putArtifact('recorded output', 'text/plain');

      const removed = await database.clear();
      expect(removed).toEqual({ states: 2, embeddings: 1, artifacts: 1 });

      expect(await database.readState('episodes')).toBeUndefined();
      expect(await database.readState('knowledge')).toBeUndefined();
      expect(await database.getVectors(['k1'], 'm')).toEqual([]);
      await expect(database.readArtifact(artifact.id)).rejects.toThrow(/Unknown memory artifact/);
    });

    it('deletes the artifact files from disk, not just their rows', async () => {
      const artifact = await database.putArtifact('on disk', 'text/plain');
      const file = path.join(root, 'artifacts', artifact.id);
      expect(await fs.readFile(file, 'utf8')).toBe('on disk');

      await database.clear();
      await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('keeps the database usable afterwards', async () => {
      await save('episodes', { schemaVersion: 1, records: [] });
      await database.clear();
      // A cleared store must accept new writes; clearing is not closing.
      await save('episodes', { schemaVersion: 1, records: [{ id: 'fresh' }] });
      expect(await database.readState('episodes')).toEqual({ schemaVersion: 1, records: [{ id: 'fresh' }] });
      expect(await database.clear()).toEqual({ states: 1, embeddings: 0, artifacts: 0 });
    });

    it('reports zeroes on an empty store without failing', async () => {
      expect(await database.clear()).toEqual({ states: 0, embeddings: 0, artifacts: 0 });
    });

    it('releases the lock so a later operation can proceed', async () => {
      await database.clear();
      await expect(fs.stat(path.join(root, 'memory.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
