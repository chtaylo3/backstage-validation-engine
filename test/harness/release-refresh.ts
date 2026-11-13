import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digestJson } from '../../src/base/json.js';
import { parsePinnedInventory } from './pinned-matrix.js';
import type { PinnedInventory } from './pinned-matrix.js';
import { selectLatestReleaseVersions } from './version-matrix.js';

export const RELEASE_INDEX = 'https://api.github.com/repos/backstage/backstage/releases';
type Fetcher = (url: string) => Promise<Response>;
export interface RefreshedInventory {
  readonly inventory: PinnedInventory;
  readonly artifacts: readonly { readonly path: string; readonly bytes: Uint8Array }[];
}

/** Capture time changes on every refresh; all version, source and contract changes are significant. */
export function sameReleaseInventory(left: PinnedInventory, right: PinnedInventory): boolean {
  const comparable = (inventory: PinnedInventory) => ({
    schemaVersion: inventory.schemaVersion,
    releaseIndexUrl: inventory.releaseIndexUrl,
    supportedMinors: [...inventory.supportedMinors].sort(),
    observedVersions: [...inventory.observedVersions].sort(),
    releases: [...inventory.releases].sort((a, b) =>
      a.backstageVersion.localeCompare(b.backstageVersion),
    ),
  });
  return digestJson(comparable(left)) === digestJson(comparable(right));
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Unexpected upstream object');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Unexpected upstream string');
  return value;
}

/** Read-only upstream discovery. All fetching finishes before local artifacts are changed. */
export async function refreshReleaseInventory(
  supportedMinors: readonly string[],
  fetcher: Fetcher = (url) =>
    fetch(url, {
      headers: { 'user-agent': 'backstage-validation-engine-fixtures' },
      signal: AbortSignal.timeout(15_000),
    }),
  refreshedAt = new Date().toISOString(),
): Promise<RefreshedInventory> {
  const get = async (url: string): Promise<Uint8Array> => {
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`Upstream request failed (${response.status}): ${url}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024) throw new Error('Upstream artifact exceeds 8 MiB');
    return bytes;
  };
  const json = async (url: string): Promise<unknown> =>
    JSON.parse(Buffer.from(await get(url)).toString('utf8')) as unknown;
  const versions = new Set<string>();
  let exhausted = false;
  for (let page = 1; page <= 100; page++) {
    const releases = await json(`${RELEASE_INDEX}?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error('Unexpected upstream release list');
    for (const raw of releases) {
      const release = record(raw);
      if (release.draft !== false || release.prerelease !== false) continue;
      const tag = text(release.tag_name);
      const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.(0|[1-9]\d*)$/.exec(tag);
      if (match && supportedMinors.includes(match[1]!)) versions.add(tag.slice(1));
    }
    if (releases.length < 100) {
      exhausted = true;
      break;
    }
  }
  if (!exhausted) throw new Error('Release discovery exceeded pagination limit');
  const observedVersions = [...versions].sort((a, b) => {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    return left[0]! - right[0]! || left[1]! - right[1]! || left[2]! - right[2]!;
  });
  const latest = selectLatestReleaseVersions(supportedMinors, observedVersions);
  const artifacts: { path: string; bytes: Uint8Array }[] = [];
  const releases = [];
  for (const version of latest) {
    let object = record(
      record(
        await json(`https://api.github.com/repos/backstage/backstage/git/ref/tags/v${version}`),
      ).object,
    );
    for (let depth = 0; object.type === 'tag' && depth < 4; depth++) {
      const sha = text(object.sha);
      if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid upstream tag SHA');
      object = record(
        record(await json(`https://api.github.com/repos/backstage/backstage/git/tags/${sha}`))
          .object,
      );
    }
    if (object.type !== 'commit') throw new Error('Release tag did not resolve to a commit');
    const sourceCommit = text(object.sha);
    if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Invalid upstream commit');
    const rawBase = `https://raw.githubusercontent.com/backstage/backstage/${sourceCommit}/`;
    const [backend, model, spec, license] = await Promise.all([
      json(`${rawBase}plugins/catalog-backend/package.json`),
      json(`${rawBase}packages/catalog-model/package.json`),
      get(`${rawBase}plugins/catalog-backend/src/schema/openapi.yaml`),
      get(`${rawBase}LICENSE`),
    ]);
    const artifactPath = `${version}/${sourceCommit}/openapi.yaml`;
    artifacts.push(
      { path: artifactPath, bytes: spec },
      { path: `${version}/${sourceCommit}/LICENSE`, bytes: license },
    );
    releases.push({
      backstageVersion: version,
      catalogBackendVersion: text(record(backend).version),
      catalogModelVersion: text(record(model).version),
      sourceCommit,
      openApi: { path: artifactPath, sha256: createHash('sha256').update(spec).digest('hex') },
    });
  }
  const inventory = parsePinnedInventory({
    schemaVersion: 1,
    refreshedAt,
    releaseIndexUrl: RELEASE_INDEX,
    supportedMinors: [...supportedMinors],
    observedVersions,
    releases,
  });
  return { inventory, artifacts };
}

/** Publish the manifest last; an interrupted refresh cannot point at partially written artifacts. */
export async function saveReleaseInventory(
  root: string,
  refreshed: RefreshedInventory,
): Promise<void> {
  parsePinnedInventory(refreshed.inventory);
  const expected = new Map<string, string | undefined>();
  for (const release of refreshed.inventory.releases) {
    const expectedPath = `${release.backstageVersion}/${release.sourceCommit}/openapi.yaml`;
    if (release.openApi.path !== expectedPath) throw new Error('Unexpected refresh artifact path');
    expected.set(expectedPath, release.openApi.sha256);
    expected.set(`${release.backstageVersion}/${release.sourceCommit}/LICENSE`, undefined);
  }
  if (refreshed.artifacts.length !== expected.size) throw new Error('Incomplete refresh artifacts');
  const seen = new Set<string>();
  for (const artifact of refreshed.artifacts) {
    if (!expected.has(artifact.path) || seen.has(artifact.path))
      throw new Error('Unexpected refresh artifact');
    seen.add(artifact.path);
    const digest = expected.get(artifact.path);
    if (
      digest !== undefined &&
      createHash('sha256').update(artifact.bytes).digest('hex') !== digest
    ) {
      throw new Error('Refresh artifact checksum mismatch');
    }
  }
  await mkdir(root, { recursive: true });
  for (const artifact of refreshed.artifacts) {
    const destination = path.join(root, artifact.path);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await writeFile(destination, artifact.bytes, { flag: 'wx' });
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      if (!Buffer.from(await readFile(destination)).equals(artifact.bytes)) {
        throw new Error('An immutable upstream artifact changed; refusing to overwrite it', {
          cause: error,
        });
      }
    }
  }
  const temporary = path.join(root, `inventory.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(refreshed.inventory, null, 2)}\n`);
  await rename(temporary, path.join(root, 'inventory.json'));
}
