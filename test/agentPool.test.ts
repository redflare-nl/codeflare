import { describe, expect, it } from 'vitest';
import { AgentPool, AsyncMutex } from '../src/engine/agentPool';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('AgentPool', () => {
  it('shares a strict concurrency limit across independent submitters and starts FIFO', async () => {
    const pool = new AgentPool(2);
    const gates = Array.from({ length: 4 }, () => deferred<number>());
    const started: number[] = [];
    const jobs = gates.map((gate, i) => pool.run(async () => { started.push(i); return gate.promise; }));
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(pool.active).toBe(2);
    expect(pool.pending).toBe(2);

    // Finish the second worker first: the next queued worker must take its slot.
    gates[1].resolve(10);
    await jobs[1];
    expect(started).toEqual([0, 1, 2]);
    expect(pool.active).toBe(2);
    expect(pool.pending).toBe(1);
    gates[0].resolve(0);
    await jobs[0];
    expect(started).toEqual([0, 1, 2, 3]);
    gates[2].resolve(20);
    gates[3].resolve(30);
    expect(await Promise.all(jobs)).toEqual([0, 10, 20, 30]);
    expect(pool.active).toBe(0);
    expect(pool.pending).toBe(0);
  });

  it('releases exactly one slot on sync throws and rejected promises', async () => {
    const pool = new AgentPool(1);
    const first = pool.run<number>(() => { throw new Error('sync failure'); });
    const second = pool.run<number>(async () => { throw new Error('async failure'); });
    const third = pool.run(async () => 42);
    const results = await Promise.allSettled([first, second, third]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
    expect(await third).toBe(42);
    expect(pool.active).toBe(0);
    expect(pool.pending).toBe(0);
  });

  it('cancels queued and future jobs while retaining active slots until completion', async () => {
    const pool = new AgentPool(1);
    const gate = deferred<number>();
    const active = pool.run(() => gate.promise);
    let queuedStarted = false;
    const queued = pool.run(async () => { queuedStarted = true; return 2; });
    const queuedResult = Promise.allSettled([queued]);
    pool.cancelPending('Task stopped');
    pool.cancelPending('Second cancellation');
    expect(pool.active).toBe(1);
    expect(pool.pending).toBe(0);
    expect(await queuedResult).toEqual([{ status: 'rejected', reason: new Error('Task stopped') }]);
    await expect(pool.run(async () => 3)).rejects.toThrow('Task stopped');
    gate.resolve(1);
    expect(await active).toBe(1);
    expect(pool.active).toBe(0);
    expect(queuedStarted).toBe(false);
    await expect(pool.run(async () => 4)).rejects.toThrow('Task stopped');
  });

  it('does not double-release when an active job fails after cancellation', async () => {
    const pool = new AgentPool(1);
    const gate = deferred();
    const result = Promise.allSettled([pool.run(() => gate.promise)]);
    pool.cancelPending();
    expect(pool.active).toBe(1);
    gate.reject(new Error('aborted worker'));
    expect((await result)[0].status).toBe('rejected');
    expect(pool.active).toBe(0);
  });

  it.each([
    [-20, 1], [0, 1], [1, 1], [4.9, 4], [32, 32], [999, 32], [NaN, 1], [Infinity, 1],
  ])('bounds configured limit %s to %s', (configured, expected) => {
    expect(new AgentPool(configured).limit).toBe(expected);
  });
});

describe('AsyncMutex', () => {
  it('serializes shared changes across awaits without losing updates', async () => {
    const mutex = new AsyncMutex();
    const firstGate = deferred();
    const events: string[] = [];
    let total = 0;
    const first = mutex.runExclusive(async () => {
      events.push('first start');
      const before = total;
      await firstGate.promise;
      total = before + 1;
      events.push('first end');
    });
    const second = mutex.runExclusive(async () => {
      events.push('second start');
      const before = total;
      await Promise.resolve();
      total = before + 1;
      events.push('second end');
    });
    await Promise.resolve();
    expect(events).toEqual(['first start']);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(total).toBe(2);
    expect(events).toEqual(['first start', 'first end', 'second start', 'second end']);
  });

  it('allows subsequent mutations after a failure', async () => {
    const mutex = new AsyncMutex();
    const failed = mutex.runExclusive(() => { throw new Error('mutation failed'); });
    const next = mutex.runExclusive(async () => 'recovered');
    await expect(failed).rejects.toThrow('mutation failed');
    expect(await next).toBe('recovered');
  });
});
