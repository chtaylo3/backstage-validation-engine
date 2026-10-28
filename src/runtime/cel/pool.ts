import { Worker } from 'node:worker_threads';
import type { JsonValue } from '../../contracts/schemas.js';
import type { Immutable } from '../../core/json.js';
import type { EvaluationContext } from '../request-budget.js';
import { cancellationError, CelError } from './errors.js';
import { snapshotCelInput } from './input.js';
import { CEL_LIMITS } from './limits.js';
import { isReadyMessage, isWorkerReply } from './protocol.js';

export interface CelRuntimeStats {
  readonly workers: number;
  readonly active: number;
  readonly queued: number;
  readonly pending: number;
  readonly workerStarts: number;
  readonly closed: boolean;
}

export interface CelRuntime {
  evaluate(expression: string, entity: unknown, context: EvaluationContext): Promise<boolean>;
  warm(): Promise<void>;
  close(): Promise<void>;
  stats(): CelRuntimeStats;
}

/** Internal constructor configuration, supplied by trusted process setup/tests. */
export interface PoolOptions {
  readonly workers?: number;
  readonly pending?: number;
  readonly executionMs?: number;
  readonly queueMs?: number;
  readonly startupMs?: number;
  readonly workerUrl?: URL;
}

interface Slot {
  worker: Worker | undefined;
  ready: Promise<Worker> | undefined;
  stopping: Promise<void> | undefined;
  running: Promise<void> | undefined;
  job: Job | undefined;
}

interface Job {
  readonly id: number;
  readonly requestId: string;
  readonly expression: string;
  readonly entity: Immutable<JsonValue>;
  readonly deadline: number;
  readonly queuedUntil: number;
  readonly executionMs: number;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (value: boolean) => void;
  readonly reject: (error: CelError) => void;
  readonly abortListener: () => void;
  queueTimer: ReturnType<typeof setTimeout> | undefined;
  requestTimer: ReturnType<typeof setTimeout> | undefined;
  slot: Slot | undefined;
  abortActive: ((error: CelError) => void) | undefined;
  failure: CelError | undefined;
}

const REPLACE_ON_ERROR = new Set([
  'execution_timeout',
  'request_timeout',
  'cancelled',
  'worker_start',
  'worker_failure',
  'protocol',
  'closed',
]);

function bounded(value: number, ceiling: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new RangeError('CEL configuration may only lower profile ceilings');
  }
  return value;
}

function throwIfJobInterrupted(job: Job): void {
  if (job.failure) throw job.failure;
  if (performance.now() >= job.deadline) throw new CelError('request_timeout');
}

/** Two fixed execution slots; queued requests are dispatched round-robin. */
export class ManagedCelPool implements CelRuntime {
  private readonly slots: Slot[];
  private readonly pending = new Map<number, Job>();
  private readonly queues = new Map<string, Job[]>();
  private readonly rotation: string[] = [];
  private readonly maxPending: number;
  private readonly executionMs: number;
  private readonly queueMs: number;
  private readonly startupMs: number;
  private readonly workerUrl: URL;
  private nextId = 0;
  private workerStarts = 0;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(options: PoolOptions = {}) {
    const workers = bounded(options.workers ?? CEL_LIMITS.workers, CEL_LIMITS.workers);
    this.slots = Array.from({ length: workers }, () => ({
      worker: undefined,
      ready: undefined,
      stopping: undefined,
      running: undefined,
      job: undefined,
    }));
    this.maxPending = bounded(
      options.pending ?? workers * CEL_LIMITS.pendingPerWorker,
      workers * CEL_LIMITS.pendingPerWorker,
    );
    this.executionMs = bounded(
      options.executionMs ?? CEL_LIMITS.executionMs,
      CEL_LIMITS.executionMs,
    );
    this.queueMs = bounded(options.queueMs ?? CEL_LIMITS.queueMs, CEL_LIMITS.queueMs);
    this.startupMs = bounded(options.startupMs ?? CEL_LIMITS.startupMs, CEL_LIMITS.startupMs);
    this.workerUrl = options.workerUrl ?? new URL('./worker.js', import.meta.url);
  }

  async warm(): Promise<void> {
    if (this.closed) throw new CelError('closed');
    await Promise.all(this.slots.map((slot) => this.ensureWorker(slot)));
  }

  stats(): CelRuntimeStats {
    const active = this.slots.filter((slot) => slot.job !== undefined).length;
    return Object.freeze({
      workers: this.slots.filter((slot) => slot.worker !== undefined || slot.stopping !== undefined)
        .length,
      active,
      queued: this.pending.size - active,
      pending: this.pending.size,
      workerStarts: this.workerStarts,
      closed: this.closed,
    });
  }

  async evaluate(
    expression: string,
    entity: unknown,
    context: EvaluationContext,
  ): Promise<boolean> {
    if (this.closed) throw new CelError('closed');
    if (context.signal?.aborted) throw cancellationError(context.signal);
    const remaining = context.deadlineAt - Date.now();
    if (
      !Number.isSafeInteger(context.deadlineAt) ||
      remaining > CEL_LIMITS.requestMs ||
      typeof context.requestId !== 'string' ||
      !context.requestId ||
      context.requestId.length > 4096
    ) {
      throw new RangeError(
        'CEL evaluation requires a request identity and a deadline within five seconds',
      );
    }
    if (remaining <= 0) throw new CelError('request_timeout');
    if (this.pending.size >= this.maxPending) throw new CelError('queue_limit');
    const executionMs = Math.min(
      this.executionMs,
      bounded(context.executionMs ?? CEL_LIMITS.executionMs, CEL_LIMITS.executionMs),
    );
    const deadline = performance.now() + remaining;
    const snapshot = snapshotCelInput(expression, entity);
    if (performance.now() >= deadline) throw new CelError('request_timeout');
    return new Promise<boolean>((resolve, reject) => {
      const job: Job = {
        id: ++this.nextId,
        requestId: context.requestId,
        expression,
        entity: snapshot,
        deadline,
        queuedUntil: performance.now() + this.queueMs,
        executionMs,
        signal: context.signal,
        resolve,
        reject,
        abortListener: () =>
          this.cancel(
            job,
            context.signal ? cancellationError(context.signal) : new CelError('cancelled'),
          ),
        queueTimer: undefined,
        requestTimer: undefined,
        slot: undefined,
        abortActive: undefined,
        failure: undefined,
      };
      this.pending.set(job.id, job);
      const queue = this.queues.get(job.requestId);
      if (queue) queue.push(job);
      else {
        this.queues.set(job.requestId, [job]);
        this.rotation.push(job.requestId);
      }
      job.queueTimer = setTimeout(
        () => this.cancel(job, new CelError('queue_timeout')),
        this.queueMs,
      );
      job.requestTimer = setTimeout(
        () => this.cancel(job, new CelError('request_timeout')),
        Math.max(0, deadline - performance.now()),
      );
      job.signal?.addEventListener('abort', job.abortListener, { once: true });
      this.pump();
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const job of [...this.pending.values()]) this.cancel(job, new CelError('closed'));
    this.closing = (async () => {
      const stops = this.slots.map((slot) => this.stopWorker(slot));
      const runs = this.slots.flatMap((slot) => (slot.running ? [slot.running] : []));
      const results = await Promise.allSettled([...stops, ...runs]);
      if (results.some((result) => result.status === 'rejected'))
        throw new CelError('worker_failure');
    })();
    return this.closing;
  }

  private pump(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.job || slot.stopping) continue;
      const requestId = this.rotation.shift();
      if (requestId === undefined) return;
      const queue = this.queues.get(requestId);
      const job = queue?.shift();
      if (!queue || !job) throw new Error('CEL scheduler invariant violated');
      if (queue.length) this.rotation.push(requestId);
      else this.queues.delete(requestId);
      clearTimeout(job.queueTimer);
      slot.job = job;
      job.slot = slot;
      // Assign the lifecycle promise before run() can synchronously reject/pump.
      slot.running = Promise.resolve().then(() => this.run(slot, job));
    }
  }

  private cancel(job: Job, error: CelError): void {
    if (!this.pending.has(job.id) || job.failure) return;
    job.failure = error;
    if (job.slot) {
      if (job.abortActive) job.abortActive(error);
      else void this.stopWorker(job.slot).catch(() => {});
    } else {
      const queue = this.queues.get(job.requestId);
      if (queue) {
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        if (!queue.length) {
          this.queues.delete(job.requestId);
          const rotationIndex = this.rotation.indexOf(job.requestId);
          if (rotationIndex >= 0) this.rotation.splice(rotationIndex, 1);
        }
      }
      this.finish(job, error);
    }
  }

  private finish(job: Job, error?: CelError, value?: boolean): void {
    if (!this.pending.delete(job.id)) return;
    clearTimeout(job.queueTimer);
    clearTimeout(job.requestTimer);
    job.signal?.removeEventListener('abort', job.abortListener);
    if (error) job.reject(error);
    else if (typeof value === 'boolean') job.resolve(value);
    else job.reject(new CelError('protocol'));
  }

  private async run(slot: Slot, job: Job): Promise<void> {
    let value: boolean | undefined;
    let error: CelError | undefined;
    try {
      throwIfJobInterrupted(job);
      if (performance.now() >= job.queuedUntil) throw new CelError('queue_timeout');
      const worker = await this.ensureWorker(slot);
      throwIfJobInterrupted(job);
      value = await this.execute(worker, job);
    } catch (failure) {
      error =
        job.failure ?? (failure instanceof CelError ? failure : new CelError('worker_failure'));
    }
    if (error && REPLACE_ON_ERROR.has(error.code)) {
      try {
        await this.stopWorker(slot);
      } catch {
        error = new CelError('worker_failure');
      }
    }
    job.abortActive = undefined;
    slot.job = undefined;
    slot.running = undefined;
    this.finish(job, error, value);
    this.pump();
  }

  private execute(worker: Worker, job: Job): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const executionDeadline = performance.now() + job.executionMs;
      let settled = false;
      const finish = (error?: CelError, value?: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        job.abortActive = undefined;
        worker.off('message', message);
        worker.off('error', failure);
        worker.off('exit', failure);
        if (error) reject(error);
        else if (typeof value === 'boolean') resolve(value);
        else reject(new CelError('protocol'));
      };
      const failure = () => finish(new CelError('worker_failure'));
      const message = (reply: unknown): void => {
        if (performance.now() >= job.deadline) return finish(new CelError('request_timeout'));
        if (performance.now() >= executionDeadline)
          return finish(new CelError('execution_timeout'));
        if (!isWorkerReply(reply, job.id)) return finish(new CelError('protocol'));
        if (!reply.ok) finish(new CelError(reply.code));
        else finish(undefined, reply.value);
      };
      const timer = setTimeout(() => finish(new CelError('execution_timeout')), job.executionMs);
      job.abortActive = (error) => finish(error);
      worker.once('message', message);
      worker.once('error', failure);
      worker.once('exit', failure);
      try {
        worker.postMessage({ id: job.id, expression: job.expression, entity: job.entity });
      } catch {
        finish(new CelError('worker_failure'));
      }
    });
  }

  private async ensureWorker(slot: Slot): Promise<Worker> {
    if (this.closed) throw new CelError('closed');
    if (slot.stopping) await slot.stopping;
    if (this.closed) throw new CelError('closed');
    if (slot.ready) return slot.ready;
    let worker: Worker;
    try {
      worker = new Worker(this.workerUrl, {
        env: {},
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: CEL_LIMITS.oldSpaceMb,
          maxYoungGenerationSizeMb: CEL_LIMITS.youngSpaceMb,
          stackSizeMb: CEL_LIMITS.stackMb,
        },
      });
    } catch {
      throw new CelError('worker_start');
    }
    this.workerStarts++;
    slot.worker = worker;
    worker.on('error', () => {});
    worker.once('exit', () => {
      if (slot.worker === worker) {
        slot.worker = undefined;
        slot.ready = undefined;
      }
    });
    const starting = new Promise<Worker>((resolve, reject) => {
      let settled = false;
      const finish = (error?: CelError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.off('message', message);
        worker.off('error', failure);
        worker.off('exit', failure);
        if (error) reject(error);
        else resolve(worker);
      };
      const message = (value: unknown) =>
        finish(isReadyMessage(value) ? undefined : new CelError('protocol'));
      const failure = () => finish(new CelError('worker_start'));
      const timer = setTimeout(() => {
        finish(new CelError('worker_start'));
      }, this.startupMs);
      worker.once('message', message);
      worker.once('error', failure);
      worker.once('exit', failure);
    });
    slot.ready = starting.catch(async (error: unknown) => {
      await this.stopWorker(slot);
      if (this.closed) throw new CelError('closed');
      throw error;
    });
    // warm() and run() observe this promise; prevent transient unhandled rejection.
    void slot.ready.catch(() => {});
    return slot.ready;
  }

  private stopWorker(slot: Slot): Promise<void> {
    if (slot.stopping) return slot.stopping;
    const worker = slot.worker;
    slot.worker = undefined;
    slot.ready = undefined;
    if (!worker) return Promise.resolve();
    slot.stopping = worker
      .terminate()
      .then(
        () => {},
        () => {
          this.closed = true;
          for (const job of [...this.pending.values()])
            this.cancel(job, new CelError('worker_failure'));
          throw new CelError('worker_failure');
        },
      )
      .finally(() => {
        slot.stopping = undefined;
      });
    return slot.stopping;
  }
}
