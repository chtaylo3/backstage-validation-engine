import { watchFile, unwatchFile } from 'node:fs';
import type { Disposable } from 'vscode-languageserver/node';

type Watch = (filename: string, changed: () => void) => () => void;
const poll: Watch = (filename, changed) => {
  watchFile(filename, { persistent: false, interval: 500 }, changed);
  return () => unwatchFile(filename, changed);
};
/** The process owns the fixed configuration watch. Sessions own returned credential watches. */
export class TrustedFileWatches {
  private closed = false;
  private readonly stop: () => void;
  constructor(
    private readonly filename: string,
    private readonly changed: () => void,
    private readonly watch: Watch = poll,
    /**
     * Whether the configuration file still holds the bytes that the configuration in use was read
     * from. An explicit reload request and this watch both see one change of the file. Without
     * this check the watch reloads what the request already loaded: it replaces the session with
     * an equal one and refuses every request meanwhile. Credential changes are not subject to it.
     */
    inUse?: () => Promise<boolean>,
  ) {
    this.stop = watch(filename, () => {
      if (this.closed) return;
      if (inUse) void this.reloadUnlessInUse(inUse);
      else changed();
    });
  }
  /** Anything short of proof that the file is unchanged reloads, as a change does. */
  private async reloadUnlessInUse(inUse: () => Promise<boolean>): Promise<void> {
    const unchanged = await inUse().catch(() => false);
    if (!unchanged && !this.closed) this.changed();
  }
  credential(filename: string | undefined): Disposable | void {
    if (this.closed || !filename || filename === this.filename) return;
    let active = true;
    const stop = this.watch(filename, () => {
      if (active && !this.closed) this.changed();
    });
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        stop();
      },
    };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
  }
}
