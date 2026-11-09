import type { Diagnostic, PublishDiagnosticsParams } from 'vscode-languageserver/node';

export interface DiagnosticContext {
  readonly uri: string;
  readonly version: number;
  readonly generation: number;
  readonly lifetime: string | number;
  readonly current: () => boolean;
}
/** One connection owns diagnostic sends and guards both findings and empty clears. */
export class DiagnosticPublisher {
  private readonly published = new Map<
    string,
    Pick<DiagnosticContext, 'lifetime' | 'generation'>
  >();
  private stopped = false;
  constructor(private readonly send: (params: PublishDiagnosticsParams) => Promise<void>) {}
  async publish(context: DiagnosticContext, diagnostics: Diagnostic[]): Promise<void> {
    if (this.stopped || !context.current()) return;
    const previous = this.published.get(context.uri);
    if (!diagnostics.length && previous && previous.lifetime !== context.lifetime) return;
    if (previous && previous.generation > context.generation) return;
    if (diagnostics.length)
      this.published.set(context.uri, {
        lifetime: context.lifetime,
        generation: context.generation,
      });
    else this.published.delete(context.uri);
    await this.send({ uri: context.uri, version: context.version, diagnostics });
  }
  close(): void {
    this.stopped = true;
    this.published.clear();
  }
}
