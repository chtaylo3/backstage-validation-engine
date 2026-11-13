import { systemClock } from '../base/clock.js';
import type { Clock } from '../base/clock.js';
import { cancellationError, CelError } from './cel/errors.js';
import { CEL_LIMITS } from './cel/limits.js';

export interface EvaluationContext {
  readonly requestId: string;
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
  /** A centrally assigned lower limit; never greater than the profile ceiling. */
  readonly executionMs?: number;
}

/** Typed admission rejection; preserves the existing RangeError and deadline checks. */
export class BudgetAdmissionError extends RangeError {
  override readonly name = 'BudgetAdmissionError';
  constructor(readonly reason: 'invalid_deadline' | 'deadline_out_of_range') {
    super('Request deadline must be within five seconds');
  }
}

/**
 * One scope per validation request, shared by every selector/expression/provider. Admission and the
 * `interrupted` check read `clock`; the abort timer is a real timer for the same remaining time.
 */
export class RequestBudget {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout> | undefined;
  private readonly upstream: AbortSignal | undefined;
  private readonly abortUpstream: () => void;
  private readonly deadline: number;

  constructor(
    readonly deadlineAt: number,
    upstream?: AbortSignal,
    /** The clock that decides this request; work inside the request reads time through it. */
    readonly clock: Clock = systemClock,
  ) {
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0) {
      throw new BudgetAdmissionError('invalid_deadline');
    }
    // One wall reading and one monotonic reading decide admission, expiry and the timer.
    const remaining = deadlineAt - clock.wall();
    if (remaining > CEL_LIMITS.requestMs) throw new BudgetAdmissionError('deadline_out_of_range');
    this.signal = this.controller.signal;
    this.deadline = clock.monotonic() + Math.max(0, remaining);
    this.upstream = upstream;
    this.abortUpstream = () =>
      this.controller.abort(upstream ? cancellationError(upstream) : new CelError('cancelled'));
    if (upstream?.aborted) this.abortUpstream();
    else if (remaining <= 0) this.controller.abort(new CelError('request_timeout'));
    else {
      this.timer = setTimeout(
        () => this.controller.abort(new CelError('request_timeout')),
        Math.max(0, remaining),
      );
      upstream?.addEventListener('abort', this.abortUpstream, { once: true });
    }
  }

  throwIfInterrupted(): void {
    if (this.interrupted) throw cancellationError(this.signal);
  }

  get interrupted(): boolean {
    if (!this.signal.aborted && this.clock.monotonic() >= this.deadline) {
      this.controller.abort(new CelError('request_timeout'));
    }
    return this.signal.aborted;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.upstream?.removeEventListener('abort', this.abortUpstream);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
