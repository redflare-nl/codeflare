/** Shared scheduling primitives. These have no VS Code or provider dependencies. */

interface QueuedAgent {
  start: () => void;
  reject: (reason: Error) => void;
}

/**
 * One pool belongs to one coordinating task. Every subagent must use that same
 * instance to share its limit. Active work is cancelled by its own abort signal;
 * cancelling this queue never pretends that a running worker has released a slot.
 */
export class AgentPool {
  private readonly concurrency: number;
  private running = 0;
  private readonly queue: QueuedAgent[] = [];
  private cancellation?: Error;

  constructor(limit: number) {
    this.concurrency = Number.isFinite(limit) ? Math.max(1, Math.min(32, Math.floor(limit))) : 1;
  }

  get active(): number { return this.running; }
  get pending(): number { return this.queue.length; }
  get limit(): number { return this.concurrency; }

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.cancellation) { return Promise.reject(this.cancellation); }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        reject,
        start: () => {
          this.running++;
          // Calling work in a promise continuation handles synchronous throws too.
          Promise.resolve().then(work).then(
            value => { this.release(); resolve(value); },
            error => { this.release(); reject(error); },
          );
        },
      });
      this.drain();
    });
  }

  /** Permanently close this pool and reject work that has not started. */
  cancelPending(reason: string | Error = 'Agent pool cancelled'): void {
    if (!this.cancellation) {
      this.cancellation = reason instanceof Error ? reason : new Error(reason);
    }
    for (const entry of this.queue.splice(0)) { entry.reject(this.cancellation); }
  }

  private release(): void {
    this.running--;
    this.drain();
  }

  private drain(): void {
    while (!this.cancellation && this.running < this.concurrency && this.queue.length) {
      this.queue.shift()!.start();
    }
  }
}

/** FIFO lock for shared mutations. A failed action does not poison the queue. */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  /** Do not acquire this same mutex recursively inside work. */
  runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
