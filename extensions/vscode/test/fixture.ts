import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import * as vscode from 'vscode';
import { readProvider, until } from './readiness.js';
import type {
  CoverageObservation,
  FilesystemObservation,
} from '../../../src/lsp/coverage-observation.js';
export { until } from './readiness.js';

export interface Api {
  filesystemObservation(): Promise<FilesystemObservation | null>;
  coverage(uri: string, version: number, digest: string): Promise<CoverageObservation | null>;
  status(): { running: boolean; pid?: number; disconnected?: boolean };
}
export const team =
  'apiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata: {name: team}\nspec: {type: team, children: []}\n';
export const invalidTeam =
  'apiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata: {name: team}\nspec: {}\n';
export async function bounded<T>(
  work: PromiseLike<T>,
  description: string,
  ms = 65_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out: ' + description)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function exited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
}
export function guardedCommand(
  action: vscode.CodeAction | vscode.Command,
): vscode.Command | undefined {
  const command = typeof action.command === 'string' ? (action as vscode.Command) : action.command;
  return command?.command === 'bve.applyFix' ? command : undefined;
}
export class Fixture {
  api: Api | undefined;
  readonly pids = new Set<number>();
  readinessCancellations = 0;
  readonly observations: { event: string; at: number }[] = [];
  checkpoint: () => Promise<void> = () => Promise.resolve();
  provider<T>(
    command:
      | 'vscode.executeCompletionItemProvider'
      | 'vscode.executeHoverProvider'
      | 'vscode.executeCodeActionProvider',
    ...args: unknown[]
  ): Promise<T> {
    return readProvider(
      () => vscode.commands.executeCommand<T>(command, ...args),
      'readiness of ' + command,
      () => {
        this.readinessCancellations++;
        this.note(command + ' readiness cancelled by editor');
      },
    );
  }
  note(event: string): void {
    if (this.observations.length < 128) this.observations.push({ event, at: Date.now() });
  }
  readonly uri = vscode.Uri.file(
    path.join(process.env.BVE_EXTENSION_TEST_WORKSPACE!, 'catalog.yaml'),
  );
  readonly teamUri = vscode.Uri.file(
    path.join(process.env.BVE_EXTENSION_TEST_WORKSPACE!, 'team.yaml'),
  );
  async setup(initialRunning = true, activate = true): Promise<void> {
    assert.equal(
      vscode.version,
      process.env.BVE_EXTENSION_TEST_VERSION,
      'Execute in the requested editor, independently of the CLI installer.',
    );
    const extension = vscode.extensions.getExtension<Api>('chtaylo3.backstage-validation-engine');
    if (!extension) {
      assert(!activate, 'Installed VSIX must be discoverable.');
      return;
    }
    const installed = process.env.BVE_EXTENSION_TEST_INSTALL!;
    assert(
      path.resolve(extension.extensionPath).startsWith(path.resolve(installed) + path.sep),
      'Test the installed VSIX, not a development override.',
    );
    if (!activate) return;
    this.api = await bounded(extension.activate(), 'product activation');
    if (initialRunning) {
      await until(() => this.api!.status().running, 'packaged server startup');
      this.pid();
    } else assert.equal(this.api.status().running, false, 'Negative startup must stay stopped.');
    await this.checkpoint();
  }
  async trustedActivation(): Promise<void> {
    await until(() => vscode.workspace.isTrusted, 'native Workspace Trust grant');
    await until(
      () =>
        vscode.extensions.getExtension<Api>('chtaylo3.backstage-validation-engine')?.isActive ===
        true,
      'product automatically activates after consent',
    );
    const extension = vscode.extensions.getExtension<Api>('chtaylo3.backstage-validation-engine')!;
    assert(
      path
        .resolve(extension.extensionPath)
        .startsWith(path.resolve(process.env.BVE_EXTENSION_TEST_INSTALL!) + path.sep),
    );
    this.api = extension.exports;
    await until(() => this.api!.status().running, 'trusted packaged server startup');
    this.pid();
    await this.checkpoint();
  }
  pid(): number {
    const pid = this.api?.status().pid;
    assert(pid, 'Running packaged server must expose its PID.');
    this.pids.add(pid);
    return pid;
  }
  async document(): Promise<vscode.TextDocument> {
    // Opening through the workbench avoids openTextDocument's retained model
    // reference, so closing the tab exercises an actual didClose lifetime.
    await vscode.commands.executeCommand('vscode.open', this.uri, { preview: false });
    await until(
      () => vscode.window.activeTextEditor?.document.uri.fsPath === this.uri.fsPath,
      'workbench opens the configured document',
    );
    return vscode.window.activeTextEditor!.document;
  }
  has(code: string): boolean {
    return vscode.languages.getDiagnostics(this.uri).some((row) => row.code === code);
  }
  async diagnostic(code = 'production-only'): Promise<vscode.Diagnostic> {
    await until(() => this.has(code), `diagnostic ${code}`);
    return vscode.languages.getDiagnostics(this.uri).find((row) => row.code === code)!;
  }
  async fix(uri = this.uri): Promise<vscode.Command> {
    // Diagnostics and code-action context cross different editor IPC paths.
    // Query the current diagnostic each time, within the same readiness bound
    // used for completion; a one-shot early empty result is not readiness.
    let command: vscode.Command | undefined;
    let last: Record<string, unknown> = {};
    try {
      await until(async () => {
        const diagnostics = vscode.languages.getDiagnostics(uri);
        last = {
          uri: uri.toString(),
          activeUri: vscode.window.activeTextEditor?.document.uri.toString(),
          version: vscode.window.activeTextEditor?.document.version,
          status: this.api?.status(),
          diagnostics: diagnostics.map((row) => ({
            code: typeof row.code === 'object' ? row.code.value : row.code,
            message: row.message,
            data: (row as vscode.Diagnostic & { data?: unknown }).data,
          })),
        };
        const diagnostic = diagnostics.find((row) => row.code === 'production-only');
        if (!diagnostic) return false;
        let actions: (vscode.CodeAction | vscode.Command)[] | undefined;
        try {
          actions = await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
            'vscode.executeCodeActionProvider',
            uri,
            diagnostic.range,
            vscode.CodeActionKind.QuickFix.value,
          );
        } catch (error) {
          if (error instanceof Error && error.name === 'Canceled') {
            this.readinessCancellations++;
            this.note('code-action readiness cancelled by editor');
            return false;
          }
          throw error;
        }
        last.actions = actions?.map((row) => ({
          title: row.title,
          command: typeof row.command === 'string' ? row.command : row.command?.command,
        }));
        command = actions?.map(guardedCommand).find((value) => value !== undefined);
        return command !== undefined;
      }, 'installed client offers the guarded fix');
    } catch (error) {
      throw new Error(`Guarded fix readiness failed: ${JSON.stringify(last)}`, { cause: error });
    }
    assert(command, 'Installed client must offer the guarded fix.');
    this.note('guarded fix offered');
    return command;
  }
  async apply(command: vscode.Command): Promise<unknown> {
    this.note('executing guarded command');
    const result: unknown = await vscode.commands.executeCommand(
      command.command,
      ...(command.arguments as unknown[]),
    );
    this.note('guarded command returned');
    return result;
  }
  async replace(document: vscode.TextDocument, text: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
      text,
    );
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  }
  async currentDiagnostic(document: vscode.TextDocument): Promise<void> {
    try {
      await until(
        () =>
          vscode.languages
            .getDiagnostics(document.uri)
            .some(
              (row) =>
                row.code === 'production-only' &&
                (row as vscode.Diagnostic & { data?: { version: number } }).data?.version ===
                  document.version,
            ),
        'diagnostics for the current editor version',
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; version=${document.version}; status=${JSON.stringify(this.api?.status())}; diagnostics=${JSON.stringify(vscode.languages.getDiagnostics(document.uri).map((row) => ({ code: row.code, message: row.message, data: (row as vscode.Diagnostic & { data?: unknown }).data })))}`,
        { cause: error },
      );
    }
  }
  async observed(document: vscode.TextDocument, after = -1): Promise<CoverageObservation> {
    let result: CoverageObservation | null = null;
    const digest = 'sha256:' + createHash('sha256').update(document.getText()).digest('hex');
    await until(async () => {
      result = await this.api!.coverage(document.uri.toString(), document.version, digest);
      return result !== null && result.generation > after;
    }, 'completed validation of exact version/digest after generation ' + after);
    const actual = result as CoverageObservation | null;
    assert(actual);
    this.note(
      'coverage generation ' +
        actual.generation +
        ' version ' +
        document.version +
        ' digest ' +
        digest,
    );
    return actual;
  }
  async alive(pid: number, document: vscode.TextDocument, code = 'production-only'): Promise<void> {
    assert(this.api!.status().running, 'The positive control cannot use a dead server.');
    assert.equal(this.pid(), pid);
    await until(
      () =>
        vscode.languages
          .getDiagnostics(document.uri)
          .some(
            (row) =>
              row.code === code &&
              (row as vscode.Diagnostic & { data?: { version: number } }).data?.version ===
                document.version,
          ),
      'surviving current-version finding ' + code,
    );
    assert(this.api!.status().running);
    assert.equal(this.pid(), pid);
    assert(!exited(pid));
  }
  async stoppedEdit(document: vscode.TextDocument, message: string): Promise<void> {
    await vscode.commands.executeCommand('backstageValidation.showOutput');
    assert(
      (await this.trace()).includes(message),
      'Expected user-visible stopped reason: ' + message,
    );
    assert.equal(
      vscode.languages
        .getDiagnostics(document.uri)
        .filter((row) => row.source === 'backstage-validation').length,
      0,
      'Stopped client clears its diagnostics.',
    );
    const publications: vscode.Diagnostic[][] = [];
    const listener = vscode.languages.onDidChangeDiagnostics((event) => {
      if (event.uris.some((uri) => uri.toString() === document.uri.toString()))
        publications.push(
          vscode.languages
            .getDiagnostics(document.uri)
            .filter((row) => row.source === 'backstage-validation'),
        );
    });
    try {
      await this.replace(
        document,
        document.getText() + '# edited after stopped command completed\n',
      );
      // Completion crosses the editor extension-host boundary after the edit.
      // The disposed product provider cannot receive or publish new validation work.
      await this.provider(
        'vscode.executeCompletionItemProvider',
        document.uri,
        new vscode.Position(6, 11),
      );
      await vscode.commands.executeCommand('backstageValidation.stop');
      assert.equal(this.api!.status().running, false);
      assert.equal(this.api!.status().pid, undefined);
      assert(publications.every((rows) => rows.length === 0));
      assert.equal(
        vscode.languages
          .getDiagnostics(document.uri)
          .filter((row) => row.source === 'backstage-validation').length,
        0,
      );
      this.note('later edit/provider and Stop command completed without product diagnostics');
    } finally {
      listener.dispose();
    }
  }
  async control(value: Record<string, unknown>): Promise<{ id: string; reference?: string }> {
    const response = await fetch(process.env.BVE_EXTENSION_TEST_CONTROL_URL!, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + process.env.BVE_EXTENSION_TEST_CONTROL_TOKEN },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, 200, 'Fixture control request succeeds.');
    return (await response.json()) as { id: string; reference?: string };
  }
  catalogs(): { baseUrl: string; version: string }[] {
    return JSON.parse(process.env.BVE_EXTENSION_TEST_CATALOGS!) as {
      baseUrl: string;
      version: string;
    }[];
  }
  async useCatalog(index: number): Promise<void> {
    const config = process.env.BVE_EXTENSION_TEST_CONFIG!;
    const value = JSON.parse(await readFile(config, 'utf8')) as { catalog: { baseUrl: string } };
    value.catalog.baseUrl = this.catalogs()[index]!.baseUrl;
    await writeFile(config, JSON.stringify(value));
    await vscode.commands.executeCommand('backstageValidation.restart');
    await until(() => this.api!.status().running, 'restart with selected pinned catalog');
    this.pid();
  }
  async trace(): Promise<string> {
    async function find(directory: string): Promise<string[]> {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      const files: string[] = [];
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...(await find(file)));
        else if (entry.name === 'Backstage Validation.log') files.push(file);
      }
      return files;
    }
    const files = await find(path.join(process.env.BVE_EXTENSION_TEST_PROFILE!, 'logs'));
    return (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  }
  async cleanup(): Promise<void> {
    const pid = this.api?.status().pid;
    if (pid) this.pids.add(pid);
    if (this.api)
      await bounded(
        vscode.commands.executeCommand('backstageValidation.stop'),
        'stop during cleanup',
      );
    for (const known of this.pids)
      await until(() => exited(known), `server ${known} exits during cleanup`);
  }
}
