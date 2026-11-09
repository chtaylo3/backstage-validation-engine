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
export interface ClientRequest {
  readonly method: string;
  readonly params: unknown;
  readonly token: { readonly isCancellationRequested: boolean } | undefined;
}
export class LanguageClient {
  running = false;
  readonly requests: string[] = [];
  readonly requestCalls: ClientRequest[] = [];
  requestHandler: ((request: ClientRequest) => Promise<unknown>) | undefined;
  readonly notifications: { method: string; value: unknown }[] = [];
  readonly notificationHandlers = new Map<string, () => void>();
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
  onNotification(method: string, handler: () => void) {
    this.notificationHandlers.set(method, handler);
    return {
      dispose: () => {
        this.notificationHandlers.delete(method);
      },
    };
  }
  sendNotification(method: string, value: unknown) {
    this.notifications.push({ method, value });
    return Promise.resolve();
  }
  sendRequest(method: string, params?: unknown, token?: ClientRequest['token']) {
    this.requests.push(method);
    const request = { method, params, token };
    this.requestCalls.push(request);
    return this.requestHandler?.(request) ?? Promise.resolve({ reloaded: true });
  }
}
