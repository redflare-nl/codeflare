import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { inflateRawSync } from 'zlib';

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Read only the manifest and entrypoint from an ordinary VSIX (ZIP). No extraction. */
function zipEntry(archive: Buffer, wanted: string): Buffer {
  let end = archive.length - 22;
  const minimum = Math.max(0, archive.length - 22 - 65535);
  for (; end >= minimum; end--) {
    if (archive.readUInt32LE(end) === 0x06054b50 && end + 22 + archive.readUInt16LE(end + 20) === archive.length) { break; }
  }
  if (end < minimum) { throw new Error('Invalid VSIX: ZIP directory is missing.'); }
  if (archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6)) { throw new Error('Multi-volume VSIX is unsupported.'); }
  let position = archive.readUInt32LE(end + 16);
  const count = archive.readUInt16LE(end + 10);
  if (position === 0xffffffff || count === 0xffff) { throw new Error('ZIP64 VSIX is unsupported.'); }
  let found: Buffer | undefined;
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || archive.readUInt32LE(position) !== 0x02014b50) { throw new Error('Invalid VSIX directory.'); }
    const nameLength = archive.readUInt16LE(position + 28);
    const next = position + 46 + nameLength + archive.readUInt16LE(position + 30) + archive.readUInt16LE(position + 32);
    if (next > end) { throw new Error('Invalid VSIX directory bounds.'); }
    const name = archive.subarray(position + 46, position + 46 + nameLength).toString('utf8');
    if (name === wanted) {
      if (found) { throw new Error(`Duplicate VSIX entry: ${wanted}`); }
      const flags = archive.readUInt16LE(position + 8);
      const method = archive.readUInt16LE(position + 10);
      const compressedSize = archive.readUInt32LE(position + 20);
      const size = archive.readUInt32LE(position + 24);
      const local = archive.readUInt32LE(position + 42);
      if (flags & 1 || size > 64 * 1024 * 1024 || local + 30 > archive.length || archive.readUInt32LE(local) !== 0x04034b50) {
        throw new Error('Encrypted, oversized or invalid VSIX entry.');
      }
      const dataStart = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
      if (dataStart + compressedSize > position) { throw new Error('Invalid VSIX entry bounds.'); }
      const compressed = archive.subarray(dataStart, dataStart + compressedSize);
      if (method !== 0 && method !== 8) { throw new Error('Unsupported VSIX compression.'); }
      found = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
      if (found.length !== size) { throw new Error('Invalid VSIX entry size.'); }
    }
    position = next;
  }
  if (!found) { throw new Error(`VSIX is missing ${wanted}.`); }
  return found;
}

export interface CodeFlareVsix {
  version: string;
  sha256: string;
  bundleSha256: string;
}

export async function inspectCodeFlareVsix(file: string): Promise<CodeFlareVsix> {
  const archive = await readFile(file);
  const manifest = JSON.parse(zipEntry(archive, 'extension/package.json').toString('utf8'));
  if (manifest.publisher !== 'local' || manifest.name !== 'codeflare' || typeof manifest.version !== 'string' || manifest.main !== './dist/extension.js') {
    throw new Error('The VSIX must be local.codeflare with entrypoint ./dist/extension.js.');
  }
  return { version: manifest.version, sha256: sha256(archive), bundleSha256: sha256(zipEntry(archive, 'extension/dist/extension.js')) };
}
