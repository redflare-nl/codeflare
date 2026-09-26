/** Durable memory storage. Its directory must come from VS Code's storage URIs. */
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { AsyncMutex } from './agentPool';

export interface MemoryVector {
  memoryKey: string;
  model: string;
  textHash: string;
  vector: number[];
}

export interface MemoryArtifact {
  /** SHA-256 of the exact stored bytes; never a caller-supplied path. */
  id: string;
  bytes: number;
  mimeType: string;
}

export const MEMORY_DATABASE_MAX_BYTES = 20 * 1024 * 1024;
export const MEMORY_ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const APPLICATION_ID = 0x43464d31; // CFM1, distinct from unrelated SQLite files.
const SCHEMA_VERSION = 1;
const mutexes = new Map<string, AsyncMutex>();
let runtime: Promise<SqlJsStatic> | undefined;

function sqlite(): Promise<SqlJsStatic> {
  if (!runtime) {
    const bundled = path.join(__dirname, 'sql-wasm.wasm');
    runtime = initSqlJs({ locateFile: () => existsSync(bundled) ? bundled : require.resolve('sql.js/dist/sql-wasm.wasm') });
    runtime.catch(() => { runtime = undefined; });
  }
  return runtime;
}

function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }

function key(value: string, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new Error(`Invalid memory ${label}`);
  }
  return value;
}

function vectorValue(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16384
    || value.some(entry => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw new Error('Memory embeddings must contain 1–16384 finite numbers');
  }
  return value;
}

function artifactId(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) { throw new Error('Invalid memory artifact ID'); }
  return value;
}

async function regularFile(filename: string, maxBytes: number): Promise<Buffer | undefined> {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) { throw new Error(`Memory path is not a regular file: ${path.basename(filename)}`); }
    if (stat.size > maxBytes) { throw new Error(`Memory file exceeds its ${maxBytes}-byte limit`); }
    const contents = await fs.readFile(filename);
    if (contents.byteLength > maxBytes) { throw new Error(`Memory file exceeds its ${maxBytes}-byte limit`); }
    return contents;
  } catch (error) {
    if (code(error) === 'ENOENT') { return undefined; }
    throw error;
  }
}

async function privateDirectory(directory: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error('Memory directory must be a real directory, not a symbolic link'); }
  return fs.realpath(directory);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Windows does not expose directory fsync. The file itself has been synced.
    if (!['EISDIR', 'EINVAL', 'EPERM', 'EACCES', 'ENOTSUP', 'EBADF'].includes(code(error) ?? '')) { throw error; }
  } finally { await handle?.close(); }
}

async function atomicWrite(filename: string, contents: Uint8Array): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Refuse a replaced destination such as a symlink before publishing new bytes.
    try {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) { throw new Error('Unsafe memory destination'); }
    } catch (error) { if (code(error) !== 'ENOENT') { throw error; } }
    await fs.rename(temporary, filename);
    await syncDirectory(path.dirname(filename));
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch(error => { if (code(error) !== 'ENOENT') { throw error; } });
  }
}

/**
 * Each operation reloads SQLite while holding both an in-process mutex and an
 * exclusive file lock, so different extension windows cannot lose updates.
 * A failed transaction never publishes its in-memory database. Unknown versions
 * and corrupt files fail closed rather than being replaced with empty memory.
 */
export class MemoryDatabase {
  private readonly directory: string;

  constructor(directory: string) {
    if (!path.isAbsolute(directory)) { throw new Error('Memory storage needs an explicit absolute directory'); }
    this.directory = path.resolve(directory);
  }

  async readState<T>(stateKey: string): Promise<T | undefined> {
    key(stateKey, 'state key');
    return this.access(false, db => this.state<T>(db, stateKey));
  }

  /** The updater may import legacy state, but must not re-enter this database. */
  async updateState<T, R>(stateKey: string, updater: (value: T | undefined) =>
    { value: T; result: R } | Promise<{ value: T; result: R }>): Promise<R> {
    key(stateKey, 'state key');
    return this.access(true, async db => {
      const update = await updater(this.state<T>(db, stateKey));
      const json = JSON.stringify(update.value);
      if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_STATE_BYTES) {
        throw new Error('Memory state must be JSON and at most 8 MiB');
      }
      db.run('INSERT INTO states (state_key, json) VALUES (?, ?) ON CONFLICT(state_key) DO UPDATE SET json=excluded.json', [stateKey, json]);
      return update.result;
    });
  }

  async getVectors(memoryKeys: string[], model: string): Promise<MemoryVector[]> {
    key(model, 'embedding model');
    if (!Array.isArray(memoryKeys) || memoryKeys.length > 1000) { throw new Error('Request at most 1000 memory vectors'); }
    const keys = [...new Set(memoryKeys.map(value => key(value, 'vector key')))];
    if (!keys.length) { return []; }
    return this.access(false, db => {
      const vectors: MemoryVector[] = [];
      for (let offset = 0; offset < keys.length; offset += 100) {
        const batch = keys.slice(offset, offset + 100);
        const statement = db.prepare(`SELECT memory_key, model, text_hash, vector FROM embeddings WHERE model=? AND memory_key IN (${batch.map(() => '?').join(',')})`);
        try {
          statement.bind([model, ...batch]);
          while (statement.step()) {
            const row = statement.getAsObject();
            vectors.push({ memoryKey: String(row.memory_key), model: String(row.model), textHash: String(row.text_hash), vector: vectorValue(JSON.parse(String(row.vector))) });
          }
        } finally { statement.free(); }
      }
      return vectors;
    });
  }

  async putVector(memoryKey: string, model: string, textHash: string, vector: number[]): Promise<void> {
    await this.putVectors([{ memoryKey, model, textHash, vector }]);
  }

  /** One export/fsync per recall batch, rather than one per newly embedded record. */
  async putVectors(entries: MemoryVector[]): Promise<void> {
    if (!Array.isArray(entries) || entries.length > 1000) { throw new Error('Write at most 1000 memory vectors at once'); }
    const rows = entries.map(entry => [key(entry.memoryKey, 'vector key'), key(entry.model, 'embedding model'),
      key(entry.textHash, 'embedding text hash'), JSON.stringify(vectorValue(entry.vector))]);
    if (!rows.length) { return; }
    await this.access(true, db => {
      for (const row of rows) {
        db.run('INSERT INTO embeddings (memory_key, model, text_hash, vector) VALUES (?, ?, ?, ?) ON CONFLICT(memory_key, model) DO UPDATE SET text_hash=excluded.text_hash, vector=excluded.vector', row);
      }
    });
  }

  async putArtifact(content: string | Uint8Array, mimeType: string): Promise<MemoryArtifact> {
    key(mimeType, 'artifact MIME type', 200);
    if (!/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:;[\x20-\x7e]*)?$/.test(mimeType)) { throw new Error('Invalid artifact MIME type'); }
    const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
    if (bytes > MEMORY_ARTIFACT_MAX_BYTES) { throw new Error('Memory artifact exceeds the 20 MiB limit'); }
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const id = createHash('sha256').update(data).digest('hex');
    return this.access(true, async (db, directory) => {
      const artifactDirectory = await privateDirectory(path.join(directory, 'artifacts'));
      if (path.dirname(artifactDirectory) !== directory) { throw new Error('Artifact directory escaped memory storage'); }
      const filename = path.join(artifactDirectory, id);
      const old = db.exec('SELECT bytes, mime_type FROM artifacts WHERE artifact_id=?', [id])[0]?.values[0];
      const saved = await regularFile(filename, MEMORY_ARTIFACT_MAX_BYTES);
      if (saved && createHash('sha256').update(saved).digest('hex') !== id) { throw new Error('Memory artifact integrity check failed'); }
      if (old && (Number(old[0]) !== bytes || !saved)) { throw new Error('Memory artifact metadata does not match its file'); }
      if (old) { return { id, bytes, mimeType: String(old[1]) }; }
      const total = db.exec('SELECT COALESCE(SUM(bytes), 0), COUNT(*) FROM artifacts')[0].values[0];
      if (Number(total[0]) + bytes > MAX_ARTIFACT_TOTAL_BYTES || Number(total[1]) >= 1000) { throw new Error('Memory artifact store is full'); }
      if (!saved) { await atomicWrite(filename, data); }
      db.run('INSERT INTO artifacts (artifact_id, bytes, mime_type) VALUES (?, ?, ?)', [id, bytes, mimeType]);
      return { id, bytes, mimeType };
    });
  }

  async readArtifact(id: string): Promise<Uint8Array> {
    artifactId(id);
    return this.access(false, async (db, directory) => {
      const row = db.exec('SELECT bytes FROM artifacts WHERE artifact_id=?', [id])[0]?.values[0];
      if (!row) { throw new Error('Unknown memory artifact'); }
      const artifactDirectory = await privateDirectory(path.join(directory, 'artifacts'));
      if (path.dirname(artifactDirectory) !== directory) { throw new Error('Artifact directory escaped memory storage'); }
      const data = await regularFile(path.join(artifactDirectory, id), MEMORY_ARTIFACT_MAX_BYTES);
      if (!data || data.byteLength !== Number(row[0]) || createHash('sha256').update(data).digest('hex') !== id) {
        throw new Error('Memory artifact integrity check failed');
      }
      return data;
    });
  }

  /**
   * Erase every record in this store: states, embeddings and artifacts, plus the
   * artifact files on disk. Runs through the same exclusive lock as any write, so
   * it can never race a concurrent recall or experiment record. Returns what was
   * removed, so the caller can tell the user what actually happened rather than
   * assuming. The database file itself is kept (empty tables) — recreating it is
   * the access() path's job and an absent file is indistinguishable from a
   * first run, which would hide a failed delete.
   */
  async clear(): Promise<{ states: number; embeddings: number; artifacts: number }> {
    return this.access(true, async (db, directory) => {
      const count = (table: string): number =>
        Number(db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0] ?? 0);
      const removed = { states: count('states'), embeddings: count('embeddings'), artifacts: count('artifacts') };
      const ids = (db.exec('SELECT artifact_id FROM artifacts')[0]?.values ?? []).map(row => String(row[0]));
      db.run('DELETE FROM states; DELETE FROM embeddings; DELETE FROM artifacts;');
      if (ids.length) {
        const artifactDirectory = await privateDirectory(path.join(directory, 'artifacts'));
        if (path.dirname(artifactDirectory) !== directory) { throw new Error('Artifact directory escaped memory storage'); }
        for (const id of ids) {
          // Only ever unlink a name this store itself generated (a sha256 hex id),
          // and let a missing file pass — the row is what makes it reachable.
          artifactId(id);
          await fs.unlink(path.join(artifactDirectory, id))
            .catch(error => { if (code(error) !== 'ENOENT') { throw error; } });
        }
      }
      return removed;
    });
  }

  private state<T>(db: Database, stateKey: string): T | undefined {
    const row = db.exec('SELECT json FROM states WHERE state_key=?', [stateKey])[0]?.values[0];
    return row ? JSON.parse(String(row[0])) as T : undefined;
  }

  private async access<T>(write: boolean, work: (db: Database, directory: string) => T | Promise<T>): Promise<T> {
    const SQL = await sqlite();
    const directory = await privateDirectory(this.directory);
    const identity = process.platform === 'win32' ? directory.toLowerCase() : directory;
    let mutex = mutexes.get(identity);
    if (!mutex) { mutex = new AsyncMutex(); mutexes.set(identity, mutex); }
    return mutex.runExclusive(async () => {
      const lockPath = path.join(directory, 'memory.lock');
      let lock: Awaited<ReturnType<typeof fs.open>> | undefined;
      // Never steal an expired-looking lock: another host can still be writing.
      // A crash leaves an explicit lock file to investigate, not silent data loss.
      for (let attempt = 0; attempt < 200; attempt++) {
        try { lock = await fs.open(lockPath, 'wx', 0o600); break; }
        catch (error) {
          if (code(error) !== 'EEXIST') { throw error; }
          const stat = await fs.lstat(lockPath).catch(error => { if (code(error) !== 'ENOENT') { throw error; } return undefined; });
          if (stat && (!stat.isFile() || stat.isSymbolicLink())) { throw new Error('Unsafe memory lock path'); }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      if (!lock) { throw new Error('Memory storage is locked by another operation. If all CodeFlare hosts have stopped, inspect memory.lock before removing it.'); }
      let db: Database | undefined;
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
        const filename = path.join(directory, 'memory.sqlite');
        const bytes = await regularFile(filename, MEMORY_DATABASE_MAX_BYTES);
        if (bytes && bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') { throw new Error('Corrupt memory SQLite header'); }
        db = bytes ? new SQL.Database(bytes) : new SQL.Database();
        if (!bytes) {
          db.run(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};
            CREATE TABLE states (state_key TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
            CREATE TABLE embeddings (memory_key TEXT NOT NULL, model TEXT NOT NULL, text_hash TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(memory_key, model));
            CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY NOT NULL, bytes INTEGER NOT NULL, mime_type TEXT NOT NULL);`);
        } else {
          const applicationId = Number(db.exec('PRAGMA application_id')[0]?.values[0]?.[0]);
          const version = Number(db.exec('PRAGMA user_version')[0]?.values[0]?.[0]);
          if (applicationId !== APPLICATION_ID || version !== SCHEMA_VERSION) { throw new Error(`Unsupported memory database schema: ${version}`); }
          if (db.exec('PRAGMA quick_check')[0]?.values[0]?.[0] !== 'ok') { throw new Error('Corrupt memory SQLite database'); }
          // Prepare required shapes before allowing any modification of an existing file.
          db.exec('SELECT state_key, json FROM states LIMIT 0; SELECT memory_key, model, text_hash, vector FROM embeddings LIMIT 0; SELECT artifact_id, bytes, mime_type FROM artifacts LIMIT 0;');
        }
        db.run('BEGIN');
        const result = await work(db, directory);
        db.run('COMMIT');
        if (write) {
          const contents = db.export();
          if (contents.byteLength > MEMORY_DATABASE_MAX_BYTES) { throw new Error('Memory SQLite database exceeds the 20 MiB limit'); }
          await atomicWrite(filename, contents);
        }
        return result;
      } finally {
        db?.close();
        await lock.close();
        await fs.unlink(lockPath);
      }
    });
  }
}
