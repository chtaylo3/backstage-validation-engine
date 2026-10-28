import { cancellationError, CelError } from './cel/errors.js';
import { CEL_LIMITS } from './cel/limits.js';

export interface EvaluationContext {
  readonly requestId: string;
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
  /** A centrally assigned lower limit; never greater than the profile ceiling. */
  readonly executionMs?: number;
}

/** One scope per validation request, shared by every selector/expression/provider. */
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
  ) {
    if (
      !Number.isSafeInteger(deadlineAt) ||
      deadlineAt < 0 ||
      deadlineAt - Date.now() > CEL_LIMITS.requestMs
    ) {
      throw new RangeError('Request deadline must be within five seconds');
    }
    this.signal = this.controller.signal;
    this.deadline = performance.now() + Math.max(0, deadlineAt - Date.now());
    this.upstream = upstream;
    this.abortUpstream = () =>
      this.controller.abort(upstream ? cancellationError(upstream) : new CelError('cancelled'));
    if (upstream?.aborted) this.abortUpstream();
    else if (deadlineAt <= Date.now()) this.controller.abort(new CelError('request_timeout'));
    else {
      this.timer = setTimeout(
        () => this.controller.abort(new CelError('request_timeout')),
        Math.max(0, deadlineAt - Date.now()),
      );
      upstream?.addEventListener('abort', this.abortUpstream, { once: true });
    }
  }

  throwIfInterrupted(): void {
    if (this.interrupted) throw cancellationError(this.signal);
  }

  get interrupted(): boolean {
    if (!this.signal.aborted && performance.now() >= this.deadline) {
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
