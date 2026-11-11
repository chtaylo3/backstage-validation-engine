import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { writeEvidence } from '../evidence.js';
import { writeFile, rename } from 'node:fs/promises';
import * as vscode from 'vscode';
import { configuration } from '../configuration.js';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const pid = fixture.pid();
  await fixture.replace(document, document.getText().replace('owner: team', 'owner: remote-team'));
  await fixture.currentDiagnostic(document);
  const complete = () =>
    fixture.provider<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      new vscode.Position(6, 18),
    );
  await until(
    async () => (await complete()).items.some((row) => row.label === 'group:default/remote-team'),
    'authenticated remote reference positive control',
  );
  const old = await fixture.fix();
  const config = await configuration();
  const tokenFile = config.catalog!.tokenFile!;
  const cursor = await fixture.control({ op: 'cursor' });
  await writeFile(tokenFile + '.replacement', 'revoked-synthetic-credential', { mode: 0o600 });
  await rename(tokenFile + '.replacement', tokenFile);
  const text = document.getText(),
    version = document.version;
  await until(
    () =>
      vscode.languages
        .getDiagnostics(document.uri)
        .some(
          (row) =>
            row.code === 'owner-exists' &&
            (row as vscode.Diagnostic & { data?: { category: string; version: number } }).data
              ?.category === 'dependency' &&
            (row as vscode.Diagnostic & { data?: { version: number } }).data?.version ===
              document.version,
        ),
    'actual rotated token produces dependency warning',
  );
  await fixture.control({ op: 'assert-denied', after: Number(cursor.id) });
  const diagnostics = vscode.languages.getDiagnostics(document.uri);
  const dependency = diagnostics.find((row) => row.code === 'owner-exists')!;
  const policy = diagnostics.find((row) => row.code === 'production-only')!;
  assert.equal(dependency.severity, vscode.DiagnosticSeverity.Warning);
  assert.equal(
    (dependency as vscode.Diagnostic & { data: { category: string } }).data.category,
    'dependency',
  );
  assert.equal(policy.severity, vscode.DiagnosticSeverity.Error);
  assert.equal(
    (policy as vscode.Diagnostic & { data: { category: string } }).data.category,
    'policy',
  );
  const unchanged = document.getText();
  const rejected = await fixture.apply(old);
  await writeEvidence(
    path.join(
      path.dirname(process.env.BVE_EXTENSION_TEST_PROGRESS!),
      'credential-denial-observation.json',
    ),
    JSON.stringify(
      {
        pid,
        policyDigest: config.activation.policyDigest,
        initialVersion: version,
        currentVersion: document.version,
        initialDocumentDigest: 'sha256:' + createHash('sha256').update(text).digest('hex'),
        currentDocumentDigest:
          'sha256:' + createHash('sha256').update(document.getText()).digest('hex'),
        sameText: document.getText() === text,
        result: rejected,
        dependency: {
          code: dependency.code,
          severity: dependency.severity,
          category: 'dependency',
        },
        policy: { code: policy.code, severity: policy.severity, category: 'policy' },
      },
      null,
      2,
    ) + '\n',
  );
  assert.deepEqual(rejected, { applied: false, reason: 'stale' });
  assert.equal(document.getText(), unchanged);
  assert.equal(fixture.pid(), pid);
  assert.equal(document.getText(), text);
  assert.equal(document.version, version);
  const recovery = await fixture.control({ op: 'cursor' });
  await writeFile(tokenFile + '.replacement', process.env.BVE_EDITOR_CATALOG_TOKEN!, {
    mode: 0o600,
  });
  await rename(tokenFile + '.replacement', tokenFile);

  await until(
    () => !fixture.has('owner-exists'),
    'restored actual token clears dependency warning',
  );
  await fixture.control({ op: 'assert-read', after: Number(recovery.id) });
  await fixture.alive(pid, document);
  await until(
    async () => (await complete()).items.some((row) => row.label === 'group:default/remote-team'),
    'remote suggestions recover without restart',
  );
  const recoveredCoverage = await fixture.observed(document);
  assert.equal(recoveredCoverage.policyDigest, config.activation.policyDigest);
  assert.equal(document.getText(), text);
  assert.equal(document.version, version);
  assert.deepEqual(await fixture.apply(old), { applied: false, reason: 'stale' });
  const fresh = await fixture.fix();
  const applied = await fixture.apply(fresh);
  await writeEvidence(
    path.join(
      path.dirname(process.env.BVE_EXTENSION_TEST_PROGRESS!),
      'credential-recovery-observation.json',
    ),
    JSON.stringify(
      {
        pid,
        beforeVersion: version,
        currentVersion: document.version,
        sameText: document.getText() === text,
        recoveredSourceDigest: recoveredCoverage.sourceDigest,
        policyDigest: recoveredCoverage.policyDigest,
        result: applied,
      },
      null,
      2,
    ) + '\n',
  );
  assert.deepEqual(applied, { applied: true }, 'A fresh post-recovery guarded repair must apply.');
  await until(
    () => document.getText().includes('lifecycle: "production"') && !fixture.has('production-only'),
    'fresh credential-recovery repair changes and validates the scalar',
  );
  assert(document.version > version);
  await fixture.observed(document, recoveredCoverage.generation);
  assert.equal(fixture.pid(), pid);
  assert(fixture.api!.status().running);
  fixture.note(
    'same-PID actual token-file denial/recovery, old repair rejection, exact installed warning/error categories',
  );
}
