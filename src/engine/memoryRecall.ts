/** Typed recall: relevant experience, with uncertainty, never instructions granting permissions. */
import { createHash } from 'crypto';
import type { MemoryDatabase, MemoryVector } from './memoryDatabase';
import { MemoryEmbedder, normalizeMemoryVector } from './memoryEmbeddings';

export type MemoryKind = 'skill' | 'experiment' | 'failure' | 'constraint';
export type MemoryScope = 'global' | 'project';

export interface MemoryRecallRecord {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  title: string;
  text: string;
  domains: string[];
  confidence: number;
  updatedAt: number | string;
  /** Skills need an explicit eligibility decision from the controller's validation state. */
  eligible?: boolean;
  version?: number;
  source?: string;
  /** Controller-owned presentation data; deliberately excluded from semantic text and cache identity. */
  metadata?: Record<string, unknown>;
}

export interface MemoryRecallQuery {
  task: string;
  scope?: MemoryScope[];
  maxResults?: number;
  domains?: string[];
}

export interface MemoryRecallMatch extends MemoryRecallRecord {
  score: number;
  relevance: number;
  matchedDomains: string[];
}

export interface MemoryRecallResult {
  results: MemoryRecallMatch[];
  strategy: 'lexical' | 'hybrid';
  warnings: string[];
}

type VectorStore = Pick<MemoryDatabase, 'getVectors' | 'putVector'> & {
  putVectors?: (vectors: MemoryVector[]) => Promise<void>;
};
export type MemoryRecallVectorStore = VectorStore | { global: VectorStore; project?: VectorStore };
const KINDS: MemoryKind[] = ['skill', 'experiment', 'failure', 'constraint'];
const SCOPES: MemoryScope[] = ['global', 'project'];
const MAX_RECORDS = 2000;
const MAX_EMBEDDINGS = 256;
const HALF_YEAR_MS = 180 * 86400000;
const STOP_WORDS = new Set('a an and are as at be been by can de deze die dit do een en for from has het how i in is it met of on op or that the their this to van voor was we with you your'.split(' '));

function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function tokens(text: string): Set<string> {
  return new Set((text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) || [])
    .filter(token => token.length > 1 && !STOP_WORDS.has(token)));
}
function timestamp(value: number | string): number {
  return typeof value === 'number' ? value : Date.parse(value);
}
function validRecord(record: MemoryRecallRecord): boolean {
  return !!record && typeof record.id === 'string' && !!record.id.trim() && record.id.length <= 1000 &&
    KINDS.includes(record.kind) && SCOPES.includes(record.scope) &&
    typeof record.title === 'string' && record.title.length <= 10000 &&
    typeof record.text === 'string' && record.text.length <= 100000 &&
    Array.isArray(record.domains) && record.domains.length <= 50 && record.domains.every(domain => typeof domain === 'string' && domain.length <= 100) &&
    typeof record.confidence === 'number' && Number.isFinite(record.confidence) && record.confidence >= 0.15 && record.confidence <= 1 &&
    Number.isFinite(timestamp(record.updatedAt)) && timestamp(record.updatedAt) >= 0 &&
    record.eligible !== false && (record.kind !== 'skill' || record.eligible === true);
}
function lexicalRelevance(query: Set<string>, record: MemoryRecallRecord): number {
  if (!query.size) { return 0; }
  const title = tokens(record.title);
  const body = tokens(record.text);
  const domains = tokens(record.domains.join(' '));
  let matches = 0;
  for (const word of query) {
    if (title.has(word) || domains.has(word)) { matches += 1; }
    else if (body.has(word)) { matches += 0.8; }
  }
  return matches / query.size;
}
function embeddingText(record: MemoryRecallRecord): string {
  return `${record.title}\nDomains: ${record.domains.join(', ')}\n${record.text}`.slice(0, 8000);
}
function memoryKey(record: MemoryRecallRecord): string {
  return `memory:${record.scope}:${record.kind}:${hash(record.id)}`;
}
function storeFor(stores: MemoryRecallVectorStore, scope: MemoryScope): VectorStore | undefined {
  return 'getVectors' in stores ? stores : stores[scope];
}

/** Search is local by default; only an explicitly supplied embedder can send text to a provider. */
export async function recallMemories(
  query: MemoryRecallQuery,
  records: MemoryRecallRecord[],
  vectorStore: MemoryRecallVectorStore,
  embeddings?: MemoryEmbedder,
): Promise<MemoryRecallResult> {
  if (!query || typeof query.task !== 'string' || !query.task.trim() || query.task.length > 8000) {
    throw new Error('Memory recall requires a task of 1–8000 characters');
  }
  if (query.scope && (!Array.isArray(query.scope) || query.scope.some(scope => !SCOPES.includes(scope)))) {
    throw new Error('Invalid memory recall scope');
  }
  if (query.domains && (!Array.isArray(query.domains) || query.domains.length > 50 ||
      query.domains.some(domain => typeof domain !== 'string' || domain.length > 100))) {
    throw new Error('Invalid memory recall domains');
  }
  const limit = query.maxResults === undefined ? 20
    : Number.isFinite(query.maxResults) ? Math.max(0, Math.min(20, Math.floor(query.maxResults))) : 20;
  const result: MemoryRecallResult = { results: [], strategy: 'lexical', warnings: [] };
  if (!limit) { return result; }
  const scopes = query.scope ?? SCOPES;
  const queryTokens = tokens(query.task);
  const queryDomains = new Set((query.domains ?? []).map(domain => domain.toLocaleLowerCase('en-US')));
  const seen = new Set<string>();
  const now = Date.now();
  const candidates = records.filter(record => validRecord(record) && scopes.includes(record.scope))
    .sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))
    .filter(record => {
      const key = memoryKey(record);
      if (seen.has(key)) { return false; }
      seen.add(key);
      return true;
    }).slice(0, MAX_RECORDS).map(record => ({
      record,
      lexical: lexicalRelevance(queryTokens, record),
      semantic: undefined as number | undefined,
    }));
  if (!candidates.length) { return result; }

  if (embeddings) {
    try {
      const queryBatch = await embeddings.embed([query.task]);
      if (queryBatch.length !== 1) { throw new Error('Invalid query embedding'); }
      const queryVector = normalizeMemoryVector(queryBatch[0]);
      const model = embeddings.cacheKey || embeddings.model;
      const selected = [...candidates].sort((a, b) => b.lexical - a.lexical ||
        b.record.confidence - a.record.confidence || timestamp(b.record.updatedAt) - timestamp(a.record.updatedAt)).slice(0, MAX_EMBEDDINGS);
      if (candidates.length > selected.length) {
        result.warnings.push(`Semantic recall is bounded to ${MAX_EMBEDDINGS} memories; other memories use lexical ranking.`);
      }
      const vectors = new Map<string, { textHash: string; vector: number[] }>();
      for (const scope of SCOPES) {
        const scoped = selected.filter(candidate => candidate.record.scope === scope);
        const store = storeFor(vectorStore, scope);
        if (!scoped.length || !store) { continue; }
        try {
          for (const vector of await store.getVectors(scoped.map(candidate => memoryKey(candidate.record)), model)) {
            vectors.set(vector.memoryKey, vector);
          }
        } catch { result.warnings.push(`The ${scope} vector cache could not be read; embeddings will be regenerated.`); }
      }
      const missing: typeof selected = [];
      for (const candidate of selected) {
        const { record } = candidate;
        const cached = vectors.get(memoryKey(record));
        const textHash = hash(`${record.version ?? 0}\n${embeddingText(record)}`);
        try {
          if (!cached || cached.textHash !== textHash) { throw new Error('Cache miss'); }
          const vector = normalizeMemoryVector(cached.vector, queryVector.length);
          candidate.semantic = queryVector.reduce((dot, component, index) => dot + component * vector[index], 0);
        } catch { missing.push(candidate); }
      }
      if (missing.length) {
        const fresh = await embeddings.embed(missing.map(candidate => embeddingText(candidate.record)));
        if (fresh.length !== missing.length) { throw new Error('Invalid document embedding count'); }
        // Validate the entire response before saving or ranking any member of the batch.
        const normalized = fresh.map(vector => normalizeMemoryVector(vector, queryVector.length));
        const pendingWrites = new Map<MemoryScope, MemoryVector[]>();
        for (let index = 0; index < missing.length; index++) {
          const candidate = missing[index];
          const { record } = candidate;
          const vector = normalized[index];
          candidate.semantic = queryVector.reduce((dot, component, dimension) => dot + component * vector[dimension], 0);
          const writes = pendingWrites.get(record.scope) ?? [];
          writes.push({ memoryKey: memoryKey(record), model, textHash: hash(`${record.version ?? 0}\n${embeddingText(record)}`), vector });
          pendingWrites.set(record.scope, writes);
        }
        for (const [scope, writes] of pendingWrites) {
          const store = storeFor(vectorStore, scope);
          if (!store) { continue; }
          try {
            if (store.putVectors) { await store.putVectors(writes); }
            else {
              for (const item of writes) { await store.putVector(item.memoryKey, item.model, item.textHash, item.vector); }
            }
          } catch { result.warnings.push(`The ${scope} vector cache could not be saved; recall remains available.`); }
        }
      }
      result.strategy = 'hybrid';
    } catch {
      for (const candidate of candidates) { candidate.semantic = undefined; }
      result.warnings.push('Embeddings were unavailable or invalid; recall used local lexical matching.');
    }
  }

  const ranked = candidates.flatMap(candidate => {
    const { record, lexical, semantic } = candidate;
    // A highly confident but unrelated memory must not enter context just to fill a quota.
    const semanticRelevance = semantic === undefined ? 0 : Math.max(0, Math.min(1, (semantic - 0.35) / 0.65));
    const relevance = semantic === undefined ? lexical : Math.max(lexical * 0.65, semanticRelevance * 0.8 + lexical * 0.2);
    if (relevance < 0.12) { return []; }
    const matchedDomains = record.domains.filter(domain => queryDomains.has(domain.toLocaleLowerCase('en-US')));
    const freshness = Math.pow(0.5, Math.max(0, now - timestamp(record.updatedAt)) / HALF_YEAR_MS);
    const domainWeight = matchedDomains.length ? 1.15 : queryDomains.size && record.domains.length ? 0.9 : 1;
    const score = relevance * (0.35 + 0.65 * record.confidence) * (0.7 + 0.3 * freshness) * domainWeight;
    return [{ ...record, relevance, score, matchedDomains }];
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  if (!ranked.length) { return result; }
  const remaining = [...ranked];
  const counts = new Map<MemoryKind, number>();
  const take = (index: number): void => {
    const record = remaining.splice(index, 1)[0];
    result.results.push(record);
    counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
  };
  take(0);
  // Preserve useful failure patterns and constraints even when many near-duplicate skills match.
  const diversityFloor = ranked[0].score * 0.3;
  while (result.results.length < limit && remaining.length) {
    const missingKind = remaining.findIndex(record => !counts.has(record.kind) && record.score >= diversityFloor);
    if (missingKind >= 0) { take(missingKind); continue; }
    let best = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < remaining.length; index++) {
      const score = remaining[index].score / (1 + 0.35 * (counts.get(remaining[index].kind) ?? 0));
      if (score > bestScore) { bestScore = score; best = index; }
    }
    take(best);
  }
  return result;
}
