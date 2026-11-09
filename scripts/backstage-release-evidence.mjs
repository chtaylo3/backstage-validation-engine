import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyReleaseReport } from '../test/integration/backstage/lib/evidence.mjs';
import { digest } from '../test/integration/backstage/lib/seed.mjs';

const fileDigest = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

export async function loadBackstageExpectations(root, candidates) {
  assert(/^[0-9a-f]{40}$/u.test(candidates.revision));
  assert(/^[0-9a-f]{64}$/u.test(candidates.cliSha256));
  assert(/^[0-9a-f]{64}$/u.test(candidates.vsixSha256));
  const directory = path.join(root, 'test/integration/backstage');
  const json = async (file) => JSON.parse(await readFile(path.join(directory, file), 'utf8'));
  const [targets, inventory, baseline, mutation, policy, supported, captured] = await Promise.all([
    json('targets.json'),
    json('cases.json'),
    json('data/baseline.json'),
    json('data/mutation.json'),
    json('policy.json'),
    readFile(path.join(root, 'test/fixtures/backstage/support.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'test/fixtures/backstage/inventory.json'), 'utf8').then(JSON.parse),
  ]);
  assert.equal(targets.schemaVersion, 1);
  assert.equal(inventory.schemaVersion, 1);
  assert(inventory.cases.length > 0, 'Require a declared real-backend case inventory.');
  assert.equal(new Set(inventory.cases.map((row) => row.id)).size, inventory.cases.length);
  assert(
    inventory.cases.every((row) => ['environment', 'cli', 'editor', 'runner'].includes(row.scope)),
  );
  assert.deepEqual(inventory.editorVersions, ['1.106.3', '1.145.2']);
  const requiredTargets = Object.keys(targets.targets).sort();
  assert(requiredTargets.length > 0, 'Require supported Backstage applications.');
  const releases = captured.releases.filter((release) =>
    supported.supportedMinors.includes(release.backstageVersion.split('.').slice(0, 2).join('.')),
  );
  assert.deepEqual(requiredTargets, releases.map((release) => release.backstageVersion).sort());
  const details = {};
  for (const target of requiredTargets) {
    const definition = targets.targets[target];
    const release = releases.find((value) => value.backstageVersion === target);
    assert.equal(definition.sourceCommit, release.sourceCommit);
    assert.equal(
      definition.packages['@backstage/plugin-catalog-backend'],
      release.catalogBackendVersion,
    );
    assert.equal(definition.packages['@backstage/catalog-model'], release.catalogModelVersion);
    details[target] = {
      sourceCommit: definition.sourceCommit,
      packages: definition.packages,
      lockfileDigest: fileDigest(await readFile(path.join(directory, 'apps', target, 'yarn.lock'))),
      baseImage: targets.baseImage,
    };
  }
  return {
    ...candidates,
    targets: requiredTargets,
    cases: inventory.cases,
    inventoryDigest: digest(inventory),
    seedDigests: { baseline: digest(baseline), mutation: digest(mutation) },
    policyDigest: digest(policy.bundle),
    details,
  };
}

export function verifyBackstageEvidence(report, expected) {
  assert.equal(typeof report.startedAt, 'string');
  assert.equal(typeof report.completedAt, 'string');
  const startedAt = Date.parse(report.startedAt);
  const completedAt = Date.parse(report.completedAt);
  assert(
    Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt,
    'Release reports require a completed execution window.',
  );
  verifyReleaseReport(report, expected);
  for (const target of report.targets) {
    const wanted = expected.details[target.target];
    assert(wanted, 'Reject an undeclared Backstage application.');
    assert.equal(
      target.sourceCommit,
      wanted.sourceCommit,
      'Use the pinned application source commit.',
    );
    assert.deepEqual(
      target.packages,
      wanted.packages,
      'Use the pinned installed Backstage package versions.',
    );
    assert.equal(
      target.lockfileDigest,
      wanted.lockfileDigest,
      'Use the candidate application dependency lock.',
    );
    assert.equal(target.baseImage, wanted.baseImage, 'Use the pinned application base image.');
  }
  return true;
}
