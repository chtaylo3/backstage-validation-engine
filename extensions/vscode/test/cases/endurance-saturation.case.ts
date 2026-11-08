import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { createSourceSnapshot } from '../../../../src/core/snapshots.js';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const original = document.getText();
  const observations: {
    version: number;
    codes: (string | number | undefined)[];
    bounded: boolean;
  }[] = [];
  for (let operation = 0; operation < 8; operation++) {
    for (let burst = 0; burst < 3; burst++)
      await fixture.replace(document, original + `# saturation ${operation}:${burst}\n`);
    await until(
      () =>
        vscode.languages
          .getDiagnostics(document.uri)
          .some(
            (row) =>
              (row as vscode.Diagnostic & { data?: { version: number } }).data?.version ===
              document.version,
          ),
      'saturation completes or publishes a typed bound',
    );
    const diagnostics = vscode.languages.getDiagnostics(document.uri);
    const bounded = diagnostics.some((row) => row.code === 'validation/incomplete');
    assert(bounded || diagnostics.some((row) => row.code === 'production-only'));
    observations.push({
      version: document.version,
      codes: diagnostics.map((row) => (typeof row.code === 'object' ? row.code.value : row.code)),
      bounded,
    });
    assert.equal(document.getText(), original + `# saturation ${operation}:2\n`);
    if (bounded) {
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        document.uri,
        new vscode.Range(5, 0, 5, 30),
      );
      assert(
        !actions?.some((row) => row.command?.command === 'bve.applyFix'),
        'Incomplete validation cannot offer a guarded edit.',
      );
      break;
    }
  }
  await writeFile(
    path.join(path.dirname(process.env.BVE_EXTENSION_TEST_PROGRESS!), 'capacity-observations.json'),
    JSON.stringify(
      { files: 1000, initialPolicyViolations: 999, debounceMs: 0, observations },
      null,
      2,
    ) + '\n',
  );
  const file = process.env.BVE_EXTENSION_TEST_CONFIG!;
  const config = JSON.parse(await readFile(file, 'utf8')) as {
    source: ReturnType<typeof createSourceSnapshot>;
    filesystem: { files: string[]; entrypoints: string[] };
  };
  const files = config.source.files.slice(0, 2);
  config.source = createSourceSnapshot({
    repository: config.source.repository,
    revision: config.source.revision,
    ...(config.source.rootUri ? { rootUri: config.source.rootUri } : {}),
    entrypoints: files.map((row) => row.uri),
    files,
  });
  config.filesystem = {
    files: files.map((row) => row.uri),
    entrypoints: files.map((row) => row.uri),
  };
  await writeFile(file, JSON.stringify(config));
  await vscode.commands.executeCommand('backstageValidation.restart');
  await until(() => fixture.api!.status().running, 'recover from capacity workload');
  fixture.pid();
  await fixture.currentDiagnostic(document);
  await fixture.apply(await fixture.fix());
  await until(() => !fixture.has('production-only'), 'fresh guarded fix after saturation recovery');
  assert(document.getText().includes('lifecycle: "production"'));
}
