import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Ajv } from 'ajv';
import { createFixtureMatrix, selectLatestReleaseVersions } from './version-matrix.js';

const ArtifactSchema = Type.Object(
  { path: Type.String(), sha256: Type.String() },
  { additionalProperties: false },
);
const ReleaseSchema = Type.Object(
  {
    backstageVersion: Type.String(),
    catalogBackendVersion: Type.String(),
    catalogModelVersion: Type.String(),
    sourceCommit: Type.String(),
    openApi: ArtifactSchema,
  },
  { additionalProperties: false },
);
const InventorySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    refreshedAt: Type.String(),
    releaseIndexUrl: Type.Literal('https://api.github.com/repos/backstage/backstage/releases'),
    supportedMinors: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
    observedVersions: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
    releases: Type.Array(ReleaseSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type PinnedInventory = Static<typeof InventorySchema>;
const SupportSchema = Type.Object(
  { supportedMinors: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }) },
  { additionalProperties: false },
);
const validateSupport = new Ajv({ strict: true }).compile<Static<typeof SupportSchema>>(
  SupportSchema,
);
export function parseSupportConfiguration(value: unknown): readonly string[] {
  if (!validateSupport(value)) throw new Error('Invalid Backstage support configuration');
  return Object.freeze([...value.supportedMinors]);
}
const validate = new Ajv({ strict: true, allErrors: true }).compile<PinnedInventory>(
  InventorySchema,
);

export function parsePinnedInventory(value: unknown): PinnedInventory {
  if (!validate(value)) throw new Error('Invalid pinned Backstage inventory');
  if (!Number.isFinite(Date.parse(value.refreshedAt)))
    throw new Error('Invalid inventory refresh time');
  const expected = selectLatestReleaseVersions(value.supportedMinors, value.observedVersions);
  const selected = createFixtureMatrix(value).map((target) => target.backstageVersion);
  if (
    selected.length !== value.releases.length ||
    JSON.stringify(selected) !== JSON.stringify(expected)
  ) {
    throw new Error(
      'Pinned inventory must materialize exactly the latest observed patch of each supported minor',
    );
  }
  return value;
}

export async function loadPinnedMatrix(artifactRoot: string) {
  const supported = parseSupportConfiguration(
    JSON.parse(await readFile(path.join(artifactRoot, 'support.json'), 'utf8')) as unknown,
  );
  const inventory = parsePinnedInventory(
    JSON.parse(await readFile(path.join(artifactRoot, 'inventory.json'), 'utf8')) as unknown,
  );
  if (
    JSON.stringify([...supported].sort()) !== JSON.stringify([...inventory.supportedMinors].sort())
  ) {
    throw new Error('support.json differs from the pinned inventory; run fixtures:refresh');
  }
  return createFixtureMatrix(inventory);
}
