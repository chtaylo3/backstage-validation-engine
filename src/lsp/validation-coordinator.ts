export type InvalidationReason = 'buffer' | 'disk' | 'configuration' | 'selection' | 'dependencies';
export interface ValidationRun {
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly current: () => boolean;
}
export interface CoordinatorClock {
  schedule(work: () => void, milliseconds: number): () => void;
}
const defaultClock: CoordinatorClock = {
  schedule: (work, milliseconds) => {
    const timer = setTimeout(work, milliseconds);
    return () => clearTimeout(timer);
  },
};
/** One active validation and the latest pending invalidation. It owns no transport or resources. */
export class ValidationCoordinator {
  private revision = 0;
  private pending = false;
  private paused = false;
  private stopped = false;
  private timer: (() => void) | undefined;
  private active: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private readonly idle = new Set<() => void>();
  constructor(
    private readonly run: (context: ValidationRun) => Promise<void>,
    private readonly delay: () => number,
    private readonly invalidateState: (reason: InvalidationReason) => void,
    private readonly clock: CoordinatorClock = defaultClock,
    private readonly closeLimitMs = 5000,
  ) {}
  get generation() {
    return this.revision;
  }
  get status() {
    return Object.freeze({
      active: this.active ? 1 : 0,
      pending: this.pending,
      timer: !!this.timer,
      paused: this.paused,
      stopped: this.stopped,
    });
  }
  invalidate(reason: InvalidationReason): void {
    if (this.stopped) return;
    this.revision++;
    this.invalidateState(reason);
    this.controller?.abort();
    this.pending = true;
    this.timer?.();
    this.timer = undefined;
    if (!this.paused)
      this.timer = this.clock.schedule(() => {
        this.timer = undefined;
        this.drain();
      }, this.delay());
  }
  private drain(): void {
    if (this.active || !this.pending || this.stopped || this.paused) {
      this.notifyIdle();
      return;
    }
    this.pending = false;
    const generation = this.revision;
    const controller = new AbortController();
    this.controller = controller;
    const context = {
      generation,
      signal: controller.signal,
      current: () => !this.stopped && !controller.signal.aborted && generation === this.revision,
    };
    this.active = Promise.resolve()
      .then(() => (context.current() ? this.run(context) : undefined))
      .catch(() => {
        /* The run owns bounded diagnostic failure conversion. */
      })
      .finally(() => {
        this.active = undefined;
        this.controller = undefined;
        if (this.pending && !this.timer) this.drain();
        this.notifyIdle();
      });
  }
  private notifyIdle(): void {
    if (this.timer || this.active || this.pending) return;
    for (const resolve of this.idle) resolve();
    this.idle.clear();
  }
  whenIdle(): Promise<void> {
    return !this.timer && !this.active && !this.pending
      ? Promise.resolve()
      : new Promise((resolve) => this.idle.add(resolve));
  }
  pause(): void {
    this.paused = true;
    this.timer?.();
    this.timer = undefined;
    this.controller?.abort();
  }
  resume(): void {
    if (this.stopped) return;
    this.paused = false;
    if (this.pending) this.drain();
  }
  cancelActive(): Promise<void> {
    this.controller?.abort();
    return this.active ?? Promise.resolve();
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.pending = false;
    this.revision++;
    this.timer?.();
    this.timer = undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.cancelActive(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Validation shutdown deadline exceeded.')),
            this.closeLimitMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.notifyIdle();
    }
  }
}
