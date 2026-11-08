import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';

export const RevealOutputChannelOn = { Never: 4 };
export const CloseAction = { DoNotRestart: 1, Restart: 2 };
export const ErrorAction = { Continue: 1, Shutdown: 2 };
export const clients: LanguageClient[] = [];
export let starting: (() => Promise<void>) | undefined;
export let stopping: (() => Promise<void>) | undefined;
export function onStart(action?: () => Promise<void>) {
  starting = action;
}
export function onStop(action?: () => Promise<void>) {
  stopping = action;
}
export class LanguageClient {
  running = false;
  serverProcess: { pid: number } | undefined = { pid: 1000 + clients.length };
  constructor(
    readonly id: string,
    readonly name: string,
    readonly server: ServerOptions,
    readonly options: LanguageClientOptions,
  ) {
    clients.push(this);
  }
  async start() {
    await starting?.();
    this.running = true;
  }
  async stop() {
    await stopping?.();
    this.running = false;
  }
  isRunning() {
    return this.running;
  }
}
