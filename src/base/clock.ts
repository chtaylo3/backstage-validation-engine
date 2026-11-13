/**
 * A source of time. Engine decisions that read time take an optional `Clock`, with `systemClock` as
 * the default at the parameter. Real timers (`setTimeout`) stay real: a clock makes the decisions
 * that read time deterministic, it does not replace the scheduler.
 *
 * Limitation: the CEL worker pool supervises real workers by real time and receives deadlines as
 * numbers, never a clock. A run that evaluates CEL in real workers needs an injected wall clock
 * near real time; a clock far from real time needs an injected `CelRuntime` as well.
 */
export interface Clock {
  /** Epoch milliseconds; comparable with contract deadlines. */
  wall(): number;
  /** Monotonic milliseconds; for measuring elapsed time. */
  monotonic(): number;
}

/** The process clock: `Date.now()` for wall time and `performance.now()` for monotonic time. */
export const systemClock: Clock = Object.freeze({
  wall: () => Date.now(),
  monotonic: () => performance.now(),
});
