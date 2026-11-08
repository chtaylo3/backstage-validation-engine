import assert from 'node:assert/strict';
import path from 'node:path';
import * as vscode from 'vscode';

export interface Api {
  status(): { running: boolean; pid?: number };
}
export const team =
  'apiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata: {name: team}\nspec: {type: team, children: []}\n';
export const invalidTeam =
  'apiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata: {name: team}\nspec: {}\n';
export async function until(
  check: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const end = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error('Timed out: ' + description);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
  }
}
export async function bounded<T>(
  work: PromiseLike<T>,
  description: string,
  ms = 25_000,
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
export class Fixture {
  api: Api | undefined;
  readonly pids = new Set<number>();
  readonly uri = vscode.Uri.file(
    path.join(process.env.BVE_EXTENSION_TEST_WORKSPACE!, 'catalog.yaml'),
  );
  readonly teamUri = vscode.Uri.file(
    path.join(process.env.BVE_EXTENSION_TEST_WORKSPACE!, 'team.yaml'),
  );
  async setup(): Promise<void> {
    assert.equal(
      vscode.version,
      process.env.BVE_EXTENSION_TEST_VERSION,
      'Execute in the requested editor, independently of the CLI installer.',
    );
    const extension = vscode.extensions.getExtension<Api>('chtaylo3.backstage-validation-engine');
    assert(extension, 'Installed VSIX must be discoverable.');
    const installed = process.env.BVE_EXTENSION_TEST_INSTALL!;
    assert(
      path.resolve(extension.extensionPath).startsWith(path.resolve(installed) + path.sep),
      'Test the installed VSIX, not a development override.',
    );
    this.api = await bounded(extension.activate(), 'product activation');
    await until(() => this.api!.status().running, 'packaged server startup');
    this.pid();
  }
  pid(): number {
    const pid = this.api?.status().pid;
    assert(pid, 'Running packaged server must expose its PID.');
    this.pids.add(pid);
    return pid;
  }
  async document(): Promise<vscode.TextDocument> {
    const document = await vscode.workspace.openTextDocument(this.uri);
    await vscode.window.showTextDocument(document);
    return document;
  }
  has(code: string): boolean {
    return vscode.languages.getDiagnostics(this.uri).some((row) => row.code === code);
  }
  async diagnostic(code = 'production-only'): Promise<vscode.Diagnostic> {
    await until(() => this.has(code), `diagnostic ${code}`);
    return vscode.languages.getDiagnostics(this.uri).find((row) => row.code === code)!;
  }
  async fix(): Promise<vscode.Command> {
    // Diagnostics and code-action context cross different editor IPC paths.
    // Query the current diagnostic each time, within the same readiness bound
    // used for completion; a one-shot early empty result is not readiness.
    let command: vscode.Command | undefined;
    await until(async () => {
      const diagnostic = vscode.languages
        .getDiagnostics(this.uri)
        .find((row) => row.code === 'production-only');
      if (!diagnostic) return false;
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        this.uri,
        diagnostic.range,
        vscode.CodeActionKind.QuickFix.value,
      );
      command = actions?.find((row) => row.command?.command === 'bve.applyFix')?.command;
      return command !== undefined;
    }, 'installed client offers the guarded fix');
    assert(command, 'Installed client must offer the guarded fix.');
    return command;
  }
  async apply(command: vscode.Command): Promise<unknown> {
    return vscode.commands.executeCommand(command.command, ...(command.arguments as unknown[]));
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
