import { describe, expect, it, vi } from 'vitest';
import { recallMemories, MemoryRecallRecord, MemoryRecallVectorStore } from '../src/engine/memoryRecall';
import { MemoryEmbedder } from '../src/engine/memoryEmbeddings';

function memory(id: string, overrides: Partial<MemoryRecallRecord> = {}): MemoryRecallRecord {
  return {
    id, kind: 'skill', scope: 'global', title: 'WebGL visual regression',
    text: 'Mask dynamic pixels and compare deterministic frames.', domains: ['web', 'webgl'],
    confidence: 0.8, updatedAt: Date.now(), eligible: true, version: 1, ...overrides,
  };
}

function cache() {
  const values = new Map<string, { memoryKey: string; model: string; textHash: string; vector: number[] }>();
  return {
    values,
    getVectors: vi.fn(async (keys: string[], model: string) => [...values.values()].filter(value => value.model === model && keys.includes(value.memoryKey))),
    putVector: vi.fn(async (memoryKey: string, model: string, textHash: string, vector: number[]) => {
      values.set(`${model}:${memoryKey}`, { memoryKey, model, textHash, vector });
    }),
  };
}

describe('typed memory recall', () => {
  it('requires relevance and excludes candidate, ineligible and malformed memories', async () => {
    const records = [
      memory('useful'), memory('candidate', { eligible: undefined }), memory('stale', { eligible: false }),
      memory('unrelated', { title: 'SQL migration', text: 'Transactional schema upgrades', domains: ['database'], confidence: 1 }),
      memory('invalid-confidence', { confidence: NaN }), memory('invalid-time', { updatedAt: 'not a date' }),
      memory('untrusted', { confidence: 0.1 }), memory('impossible-confidence', { confidence: 4 }),
    ];
    const result = await recallMemories({ task: 'WebGL visual regression' }, records, cache());
    expect(result.results.map(record => record.id)).toEqual(['useful']);
    expect(result.strategy).toBe('lexical');
    expect(result.warnings).toEqual([]);
  });

  it('retains relevant constraints and failure patterns among many matching skills', async () => {
    const records = [
      ...Array.from({ length: 20 }, (_, index) => memory(`skill-${index}`)),
      memory('experiment', { kind: 'experiment', confidence: 0.75 }),
      memory('failure', { kind: 'failure', confidence: 0.7 }),
      memory('constraint', { kind: 'constraint', scope: 'project', confidence: 0.9 }),
    ];
    const result = await recallMemories({ task: 'WebGL visual regression', maxResults: 4 }, records, cache());
    expect(new Set(result.results.map(record => record.kind))).toEqual(new Set(['skill', 'experiment', 'failure', 'constraint']));
  });

  it('does not force irrelevant types into a diversity quota', async () => {
    const result = await recallMemories({ task: 'WebGL visual regression', maxResults: 4 }, [
      memory('skill'), memory('irrelevant', { kind: 'failure', title: 'Postgres indexes', text: 'Database storage', domains: ['sql'] }),
    ], cache());
    expect(result.results.map(record => record.id)).toEqual(['skill']);
  });

  it('uses confidence, validation recency and matching domains to rank comparable memories', async () => {
    const result = await recallMemories({ task: 'WebGL visual regression', domains: ['WEBGL'] }, [
      memory('trusted', { confidence: 0.95 }), memory('uncertain', { confidence: 0.4 }),
      memory('old', { confidence: 0.95, updatedAt: Date.now() - 365 * 86400000 }),
      memory('wrong-domain', { confidence: 0.95, domains: ['native'] }),
    ], cache());
    expect(result.results[0].id).toBe('trusted');
    expect(result.results[0].matchedDomains).toEqual(['webgl']);
    expect(result.results.find(record => record.id === 'old')!.score).toBeLessThan(result.results[0].score);
    expect(result.results.find(record => record.id === 'uncertain')!.score).toBeLessThan(result.results[0].score);
  });

  it('filters scope before embedding and keeps project vectors out of global storage', async () => {
    const global = cache(), project = cache();
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const records = [memory('shared-id'), memory('shared-id', { scope: 'project', text: 'Private project WebGL strategy' })];
    const result = await recallMemories({ task: 'WebGL', scope: ['project'] }, records, { global, project }, { model: 'embed-v1', embed });
    expect(result.results.map(record => record.scope)).toEqual(['project']);
    expect(global.getVectors).not.toHaveBeenCalled();
    expect(global.putVector).not.toHaveBeenCalled();
    expect(project.putVector).toHaveBeenCalledOnce();
    expect(embed.mock.calls.flatMap(call => call[0]).join(' ')).not.toContain('Mask dynamic pixels');
    expect(project.putVector.mock.calls[0][0]).toMatch(/^memory:project:/);
  });

  it('does not persist project vectors when no project cache is available', async () => {
    const global = cache();
    await recallMemories({ task: 'WebGL' }, [memory('private', { scope: 'project' })], { global }, {
      model: 'embed', embed: async texts => texts.map(() => [1, 0]),
    });
    expect(global.putVector).not.toHaveBeenCalled();
    expect(global.getVectors).not.toHaveBeenCalled();
  });

  it('persists a cold vector batch in one write per scope when the store supports transactions', async () => {
    const global = { ...cache(), putVectors: vi.fn(async () => {}) };
    const project = { ...cache(), putVectors: vi.fn(async () => {}) };
    const records = [memory('a'), memory('b'), memory('c', { scope: 'project' })];
    await recallMemories({ task: 'WebGL' }, records, { global, project }, {
      model: 'embed', embed: async texts => texts.map(() => [1, 0]),
    });
    expect(global.putVectors).toHaveBeenCalledOnce();
    expect(global.putVectors.mock.calls[0][0]).toHaveLength(2);
    expect(project.putVectors).toHaveBeenCalledOnce();
    expect(project.putVectors.mock.calls[0][0]).toHaveLength(1);
    expect(global.putVector).not.toHaveBeenCalled();
    expect(project.putVector).not.toHaveBeenCalled();
  });

  it('uses genuine vectors to recall semantic matches without shared query words', async () => {
    const records = [
      memory('semantic', { title: 'Smooth animation', text: 'Profile GPU frame times', domains: ['rendering'] }),
      memory('lexical', { title: 'WebGL performance', text: 'Legacy recommendation', domains: [] }),
      memory('unrelated', { title: 'Database migration', text: 'Schema files', domains: ['sql'] }),
    ];
    const embeddings: MemoryEmbedder = {
      model: 'test-semantic-v1',
      embed: async texts => texts.map(text => text.includes('Smooth animation') || text === 'WebGL performance' ? [1, 0]
        : text.includes('Legacy recommendation') ? [0.1, 0.9] : [0, 1]),
    };
    const result = await recallMemories({ task: 'WebGL performance' }, records, cache(), embeddings);
    expect(result.strategy).toBe('hybrid');
    expect(result.results[0].id).toBe('semantic');
    expect(result.results.map(record => record.id)).not.toContain('unrelated');
    expect(result.results[0].relevance).toBeCloseTo(0.8);
  });

  it('caches by scope, identity, text, version, model and endpoint identity', async () => {
    const global = cache(), project = cache();
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const embeddings = { model: 'embed-v1', cacheKey: 'server-one/embed-v1', embed };
    const records = [memory('same'), memory('same', { scope: 'project' })];
    const stores = { global, project };
    await recallMemories({ task: 'WebGL' }, records, stores, embeddings);
    expect(embed.mock.calls.map(call => call[0].length)).toEqual([1, 2]);
    await recallMemories({ task: 'WebGL' }, records, stores, embeddings);
    expect(embed.mock.calls.map(call => call[0].length)).toEqual([1, 2, 1]);
    records[0] = { ...records[0], version: 2 };
    await recallMemories({ task: 'WebGL' }, records, stores, embeddings);
    expect(embed.mock.calls.at(-1)?.[0]).toHaveLength(1);
    expect(global.putVector).toHaveBeenCalledTimes(2);
    expect(project.putVector).toHaveBeenCalledTimes(1);
    records[1] = { ...records[1], text: 'Updated project strategy' };
    await recallMemories({ task: 'WebGL' }, records, stores, embeddings);
    expect(project.putVector).toHaveBeenCalledTimes(2);
    await recallMemories({ task: 'WebGL' }, records, stores, { ...embeddings, cacheKey: 'server-two/embed-v1' });
    expect(embed.mock.calls.at(-1)?.[0]).toHaveLength(2);
  });

  it('returns controller metadata without embedding it or invalidating vectors when it changes', async () => {
    const store = cache();
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const records = [memory('match', { metadata: { successfulUses: 3, confidence: 0.75 } })];
    await recallMemories({ task: 'WebGL' }, records, store, { model: 'embedding', embed });
    expect(embed.mock.calls.flatMap(call => call[0]).join(' ')).not.toContain('successfulUses');
    records[0] = { ...records[0], metadata: { successfulUses: 4, confidence: 0.8 } };
    const result = await recallMemories({ task: 'WebGL' }, records, store, { model: 'embedding', embed });
    expect(result.results[0].metadata).toEqual({ successfulUses: 4, confidence: 0.8 });
    expect(embed.mock.calls.map(call => call[0].length)).toEqual([1, 1, 1]);
    expect(store.putVector).toHaveBeenCalledTimes(1);
  });

  it('falls back locally with an explicit warning after provider failures, without leaking error text', async () => {
    const result = await recallMemories({ task: 'WebGL' }, [memory('match')], cache(), {
      model: 'unavailable', embed: async () => { throw new Error('private-token was rejected'); },
    });
    expect(result.strategy).toBe('lexical');
    expect(result.results.map(record => record.id)).toEqual(['match']);
    expect(result.warnings).toEqual(['Embeddings were unavailable or invalid; recall used local lexical matching.']);
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it.each([[[0, 0]], [[Infinity, 0]], [[1, 0, 0]], []].map(batch => [batch]))
    ('falls back on malformed document vectors %#', async documentVectors => {
      const embed = vi.fn().mockResolvedValueOnce([[1, 0]]).mockResolvedValueOnce(documentVectors);
      const store = cache();
      const result = await recallMemories({ task: 'WebGL' }, [memory('match')], store, { model: 'broken', embed });
      expect(result.strategy).toBe('lexical');
      expect(result.results).toHaveLength(1);
      expect(store.putVector).not.toHaveBeenCalled();
    });

  it('regenerates corrupt and incompatible cached vectors', async () => {
    const store = cache();
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const embeddings = { model: 'embedding', embed };
    await recallMemories({ task: 'WebGL' }, [memory('match')], store, embeddings);
    for (const value of store.values.values()) { value.vector = [0, 0, 0]; }
    await recallMemories({ task: 'WebGL' }, [memory('match')], store, embeddings);
    expect(embed).toHaveBeenCalledTimes(4);
  });

  it('still uses fresh semantic vectors if the disk cache cannot be accessed', async () => {
    const store: MemoryRecallVectorStore = {
      getVectors: async () => { throw new Error('disk unavailable'); },
      putVector: async () => { throw new Error('disk unavailable'); },
    };
    const result = await recallMemories({ task: 'WebGL' }, [memory('match')], store, {
      model: 'embedding', embed: async texts => texts.map(() => [1, 0]),
    });
    expect(result.strategy).toBe('hybrid');
    expect(result.results).toHaveLength(1);
    expect(result.warnings).toHaveLength(2);
  });

  it('deduplicates within a scope without merging unrelated project and global identities', async () => {
    const records = [memory('same'), memory('same', { updatedAt: Date.now() - 1000 }), memory('same', { scope: 'project' })];
    const result = await recallMemories({ task: 'WebGL' }, records, cache());
    expect(result.results).toHaveLength(2);
  });

  it('handles empty scopes and clamps limits without contacting providers', async () => {
    const embed = vi.fn();
    expect((await recallMemories({ task: 'WebGL', scope: [] }, [memory('match')], cache(), { model: 'test', embed })).results).toEqual([]);
    expect((await recallMemories({ task: 'WebGL', maxResults: 0 }, [memory('match')], cache(), { model: 'test', embed })).results).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
    const records = Array.from({ length: 60 }, (_, index) => memory(String(index)));
    expect((await recallMemories({ task: 'WebGL', maxResults: 200 }, records, cache())).results).toHaveLength(20);
  });

  it('bounds semantic work and reports when remaining candidates use lexical scoring', async () => {
    const records = Array.from({ length: 260 }, (_, index) => memory(String(index)));
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const result = await recallMemories({ task: 'WebGL' }, records, cache(), { model: 'test', embed });
    expect(embed.mock.calls.map(call => call[0].length)).toEqual([1, 256]);
    expect(result.warnings).toEqual(['Semantic recall is bounded to 256 memories; other memories use lexical ranking.']);
  });

  it('rejects invalid queries', async () => {
    await expect(recallMemories({ task: '' }, [], cache())).rejects.toThrow(/task/);
    await expect(recallMemories({ task: 'x', scope: ['external' as never] }, [], cache())).rejects.toThrow(/scope/);
    await expect(recallMemories({ task: 'x', domains: [42 as never] }, [], cache())).rejects.toThrow(/domains/);
  });
});
