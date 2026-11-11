import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import type { Fixture } from '../fixture.js';
import { until } from '../fixture.js';
import { writeEvidence } from '../evidence.js';
import type { CoverageObservation } from '../../../../src/lsp/coverage-observation.js';
// Independent canonical encoding for this plain JSON fixture.
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(object)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(object[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
};
const digest = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex');
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  await fixture.currentDiagnostic(document);
  const observe = () =>
    fixture.api!.coverage(document.uri.toString(), document.version, digest(document.getText()));
  assert.equal(
    await observe(),
    null,
    'Normal launcher defaults must keep coverage observation disabled.',
  );
  const file = process.env.BVE_EXTENSION_TEST_CONFIG!;
  const original = await readFile(file, 'utf8');
  const config = JSON.parse(original) as Record<string, unknown>;
  try {
    await writeFile(file, JSON.stringify({ ...config, coverageObservation: true }));
    await vscode.commands.executeCommand('backstageValidation.reloadConfiguration');
    let observation: CoverageObservation | null = null;
    await until(async () => {
      observation = await observe();
      return observation !== null;
    }, 'installed host coverage observation');
    const actual = observation as CoverageObservation | null;
    assert(actual);
    assert.equal(actual.policyDigest, digest(canonical(config.policy)));
    assert.equal(actual.profileDigest, digest(canonical(config.profile)));
    assert.equal(actual.activationDigest, digest(canonical(config.activation)));
    assert(
      actual.documents.some(
        (row) =>
          row.uri === document.uri.toString() &&
          row.version === document.version &&
          row.digest === digest(document.getText()),
      ),
    );
    assert(
      actual.coverage.some(
        (row) =>
          row.stage === 'parse' &&
          row.subject === document.uri.toString() &&
          row.required &&
          row.status === 'verified',
      ),
    );
    assert(
      actual.coverage.some(
        (row) =>
          row.stage === 'rules' &&
          row.subject.includes('production-only') &&
          row.required &&
          row.status === 'verified',
      ),
    );
    assert(fixture.has('production-only'), 'The separate policy violation must remain observable.');
    assert.equal(
      await fixture.api!.coverage(
        document.uri.toString(),
        document.version + 1,
        digest(document.getText()),
      ),
      null,
    );
    assert.equal(
      await fixture.api!.coverage(
        'file:///foreign/catalog.yaml',
        document.version,
        digest(document.getText()),
      ),
      null,
    );
    await writeEvidence(
      path.join(
        path.dirname(process.env.BVE_EXTENSION_TEST_PROGRESS!),
        'coverage-observation.json',
      ),
      JSON.stringify(actual, null, 2) + '\n',
    );
    fixture.note('observed installed host coverage generation ' + actual.generation);
  } finally {
    await writeFile(file, original);
    await vscode.commands.executeCommand('backstageValidation.reloadConfiguration');
  }
  assert.equal(await observe(), null, 'Restoring the default launcher revokes access.');
}
