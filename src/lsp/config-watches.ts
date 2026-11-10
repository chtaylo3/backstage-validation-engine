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
  ) {
    this.stop = watch(filename, () => {
      if (!this.closed) changed();
    });
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
