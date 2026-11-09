import { CancellationTokenSource } from 'vscode-languageserver/node';
import type {
  ApplyWorkspaceEditResult,
  CancellationToken,
  WorkspaceEdit,
} from 'vscode-languageserver/node';
import { FIX_LIMITS } from './fixes.js';

type Delay = (work: () => void, ms: number) => () => void;
const delay: Delay = (work, ms) => {
  const timer = setTimeout(work, ms);
  return () => clearTimeout(timer);
};
/** A connection edit slot survives reload and local timeout until its request settles. */
export class ClientEdits {
  private slot: { cancellation: CancellationTokenSource; release: () => void } | undefined;
  private readonly waits = new Set<Promise<ApplyWorkspaceEditResult>>();
  private stopped = false;
  constructor(
    private readonly send: (
      edit: WorkspaceEdit,
      token: CancellationToken,
    ) => Promise<ApplyWorkspaceEditResult>,
    private readonly schedule: Delay = delay,
  ) {}
  get busy(): boolean {
    return !!this.slot;
  }
  cancel(): void {
    this.slot?.cancellation.cancel();
  }
  apply(edit: WorkspaceEdit, upstream: CancellationToken): Promise<ApplyWorkspaceEditResult> {
    if (this.stopped || this.slot) return Promise.reject(new Error('Client edit unavailable.'));
    const cancellation = new CancellationTokenSource();
    let released = false;
    const slot = {
      cancellation,
      release: () => {
        if (released) return;
        released = true;
        cancellation.dispose();
        if (this.slot === slot) this.slot = undefined;
      },
    };
    this.slot = slot;
    const work = (async () => {
      const clear = this.schedule(() => cancellation.cancel(), FIX_LIMITS.applyMs);
      const subscription = upstream.onCancellationRequested(() => cancellation.cancel());
      const response = Promise.resolve().then(() => this.send(edit, cancellation.token));
      void response.then(slot.release, slot.release);
      let unsubscribe: (() => void) | undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        const stop = () => reject(new Error('Fix application cancelled.'));
        const listener = cancellation.token.onCancellationRequested(stop);
        unsubscribe = () => listener.dispose();
        if (cancellation.token.isCancellationRequested || upstream.isCancellationRequested) {
          cancellation.cancel();
          stop();
        }
      });
      try {
        return await Promise.race([response, cancelled]);
      } finally {
        clear();
        subscription.dispose();
        unsubscribe?.();
      }
    })();
    this.waits.add(work);
    void work.then(
      () => this.waits.delete(work),
      () => this.waits.delete(work),
    );
    return work;
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.cancel();
    await Promise.allSettled([...this.waits]);
    this.slot?.release();
  }
}
