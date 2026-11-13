import type { Clock } from '../../src/base/clock.js';

/**
 * A `Clock` that moves only when a test moves it. `advance` moves wall and monotonic time forward
 * together, as real time does. `set` steps wall time alone, forward or backward, as a system clock
 * adjustment does; monotonic time is unchanged by it. Timers are not affected: this clock makes the
 * decisions that read time deterministic, it does not schedule anything.
 */
export class ManualClock implements Clock {
  #wall: number;
  #monotonic: number;
  constructor(wallMs = 1_700_000_000_000, monotonicMs = 1000) {
    if (!Number.isFinite(wallMs) || !Number.isFinite(monotonicMs))
      throw new RangeError('Clock times must be finite.');
    this.#wall = wallMs;
    this.#monotonic = monotonicMs;
  }
  wall(): number {
    return this.#wall;
  }
  monotonic(): number {
    return this.#monotonic;
  }
  /** Moves wall and monotonic time forward by `ms`. A negative or non-finite step throws. */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0)
      throw new RangeError('A clock advances by a nonnegative step.');
    this.#wall += ms;
    this.#monotonic += ms;
  }
  /** Steps wall time to `wallMs`, forward or backward. Monotonic time does not change. */
  set(wallMs: number): void {
    if (!Number.isFinite(wallMs)) throw new RangeError('Clock times must be finite.');
    this.#wall = wallMs;
  }
}
