import { CatalogFailure } from './types.js';

/** Bound even trusted callbacks that ignore their signal; late rejections are always observed. */
export function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const abort = () => {
      done = true;
      reject(new CatalogFailure('cancelled'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (done) {
          late?.(value);
          return;
        }
        done = true;
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        if (done) return;
        done = true;
        reject(error instanceof Error ? error : new CatalogFailure('provider_error'));
      },
    );
  });
}

export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await abortable(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Shared across this connection's callers so new requests cannot bypass Retry-After. */
export class CatalogRateLimit {
  private notBefore = 0;
  block(ms: number): void {
    this.notBefore = Math.max(this.notBefore, performance.now() + ms);
  }
  async wait(signal: AbortSignal, remainingMs: number, maxWaitMs: number): Promise<void> {
    const delay = Math.max(0, this.notBefore - performance.now());
    if (delay > maxWaitMs || delay >= remainingMs) throw new CatalogFailure('rate_limited');
    if (delay > 0) await pause(Math.ceil(delay), signal);
  }
}

/** One permit per lookup, including credential resolution, batches and retry waits. */
export class CatalogAdmission {
  private active = 0;
  private readonly queue: { enter(): void; cancel(): void }[] = [];
  constructor(
    private readonly concurrency: number,
    private readonly outstanding: number,
  ) {}
  stats() {
    return { active: this.active, queued: this.queue.length };
  }
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new CatalogFailure('cancelled'));
    if (this.active + this.queue.length >= this.outstanding)
      return Promise.reject(new CatalogFailure('queue_limit'));
    return new Promise((resolve, reject) => {
      const entry = {
        enter: () => {
          signal.removeEventListener('abort', entry.cancel);
          this.active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active--;
            this.queue.shift()?.enter();
          });
        },
        cancel: () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          signal.removeEventListener('abort', entry.cancel);
          reject(new CatalogFailure('cancelled'));
        },
      };
      if (this.active < this.concurrency) entry.enter();
      else {
        this.queue.push(entry);
        signal.addEventListener('abort', entry.cancel, { once: true });
      }
    });
  }
}
