import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { stringify } from 'yaml';
import {
  BACKSTAGE_ADAPTER_IDS,
  closeSharedCelRuntime,
  validateBackstageSources,
} from '../../src/index.js';
import type { JsonValue } from '../../src/index.js';
import { policyRun } from '../harness/policy-fixture.js';

const root = 'test/fixtures/backstage-behavior/';
const load = async (name: string) => JSON.parse(await readFile(root + name, 'utf8')) as unknown;
test.after(closeSharedCelRuntime);

void test('reviewed backend behavior sources retain exact identities and both supported pins', async () => {
  const manifest = (await load('sources.json')) as {
    notices: { path: string; sha256: string; backstageVersion: string; url: string }[];
    sources: {
      path: string;
      sha256: string;
      backstageVersion: string;
      sourceCommit: string;
      url: string;
    }[];
  };
  assert.deepEqual([...new Set(manifest.sources.map((row) => row.backstageVersion))].sort(), [
    '1.55.3',
    '1.56.3',
  ]);
  assert.equal(manifest.sources.length, 8);
  assert.equal(manifest.notices.length, 4);
  for (const notice of manifest.notices)
    assert.equal(
      createHash('sha256')
        .update(await readFile(root + notice.path))
        .digest('hex'),
      notice.sha256,
    );
  for (const row of manifest.sources) {
    assert.equal(
      createHash('sha256')
        .update(await readFile(root + row.path))
        .digest('hex'),
      row.sha256,
    );
    assert(row.url.includes(row.sourceCommit));
  }
});

void test('safe local substitution profile follows reviewed upstream cases and explicit differences on both native pins', async (t) => {
  const rows = (await load('substitutions.json')) as {
    id: string;
    marker: JsonValue;
    payload: string;
    nested?: string;
    local: { value?: JsonValue; error?: string };
  }[];
  for (const adapterId of BACKSTAGE_ADAPTER_IDS)
    for (const row of rows)
      await t.test(adapterId + '/' + row.id, async () => {
        const entity = {
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'Component',
          metadata: { name: 'subject' },
          spec: { type: 'service', lifecycle: 'production', owner: 'team', data: row.marker },
        };
        const run = policyRun({
          text: stringify(entity),
          rootUri: 'file:///workspace/',
          entrypoints: ['file:///workspace/catalog-info.yaml'],
          files: [
            { uri: 'file:///workspace/payload', text: row.payload },
            ...(row.nested ? [{ uri: 'file:///workspace/nested', text: row.nested }] : []),
          ],
          profile: { adapterId },
        });
        const report = await validateBackstageSources(run.request, run.context);
        if (row.local.error) {
          assert.equal(report.entities.length, 0);
          assert(
            report.findings.some(
              (finding) => finding.ruleId === 'backstage/substitution/' + row.local.error,
            ),
            JSON.stringify(report.findings),
          );
        } else {
          assert.deepEqual(report.findings, []);
          assert.equal(report.entities.length, 1);
          assert.deepEqual(
            (report.entities[0]!.resolved as { spec: { data: JsonValue } }).spec.data,
            row.local.value,
          );
        }
      });
});

void test('default reference profile intentionally over-approximates upstream kind-scoped relations', async (t) => {
  const rows = (await load('references.json')) as {
    id: string;
    entity: JsonValue;
    localReferences: string[];
    upstreamRelations: string[][];
  }[];
  for (const adapterId of BACKSTAGE_ADAPTER_IDS)
    for (const row of rows)
      await t.test(adapterId + '/' + row.id, async () => {
        const run = policyRun({
          text: stringify(row.entity),
          rootUri: 'file:///workspace/',
          entrypoints: ['file:///workspace/catalog-info.yaml'],
          profile: { adapterId },
        });
        const report = await validateBackstageSources(run.request, run.context);
        assert.deepEqual(report.findings, []);
        assert.deepEqual(
          report.references.map((entry) => entry.targetRef).sort(),
          row.localReferences,
        );
        assert.equal(report.entities.length, 1);
      });
});
