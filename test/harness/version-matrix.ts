/** Stable releases only. The inventory is refreshed separately from offline test execution. */
export interface BackstageRelease {
  readonly backstageVersion: string;
  readonly catalogBackendVersion: string;
  readonly catalogModelVersion: string;
  readonly sourceCommit: string;
  readonly openApi: {
    /** Relative to the harness's artifact root. */
    readonly path: string;
    /** SHA-256 of the exact upstream artifact bytes, without reformatting. */
    readonly sha256: string;
  };
}

export interface FixtureTarget extends BackstageRelease {
  readonly minorLine: string;
}

export interface MatrixInput {
  readonly supportedMinors: readonly string[];
  readonly releases: readonly BackstageRelease[];
}

function numbers(version: string, parts: 2 | 3): readonly number[] {
  const pattern =
    parts === 2 ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/ : /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!pattern.test(version)) {
    throw new Error(`Expected a stable ${parts === 2 ? 'minor line' : 'release'}: ${version}`);
  }
  const result = version.split('.').map(Number);
  if (result.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`Version component exceeds safe integer range: ${version}`);
  }
  return result;
}

/** The release index must contain stable versions only, after upstream preview filtering. */
export function selectLatestReleaseVersions(
  supportedMinors: readonly string[],
  versions: readonly string[],
): readonly string[] {
  if (supportedMinors.length === 0) throw new Error('At least one supported minor is required');
  const supported = new Set<string>();
  for (const line of supportedMinors) {
    numbers(line, 2);
    if (supported.has(line)) throw new Error(`Duplicate supported minor: ${line}`);
    supported.add(line);
  }

  const seen = new Set<string>();
  const selected = new Map<string, { patch: number; version: string }>();
  for (const version of versions) {
    const [major, minor, patch] = numbers(version, 3);
    if (seen.has(version)) {
      throw new Error(`Duplicate release inventory entry: ${version}`);
    }
    seen.add(version);
    const minorLine = `${major}.${minor}`;
    if (!supported.has(minorLine)) continue;
    const previous = selected.get(minorLine);
    if (patch !== undefined && (previous === undefined || patch > previous.patch)) {
      selected.set(minorLine, {
        patch,
        version,
      });
    }
  }

  const lines = [...supported].sort((left, right) => {
    const a = numbers(left, 2);
    const b = numbers(right, 2);
    return a[0]! - b[0]! || a[1]! - b[1]!;
  });
  return Object.freeze(
    lines.map((line) => {
      const entry = selected.get(line);
      if (!entry)
        throw new Error(`No stable release artifact available for supported minor: ${line}`);
      return entry.version;
    }),
  );
}

/** Selects exactly the highest numeric patch in each explicitly supported major.minor. */
export function createFixtureMatrix(input: MatrixInput): readonly FixtureTarget[] {
  for (const release of input.releases) {
    numbers(release.catalogBackendVersion, 3);
    numbers(release.catalogModelVersion, 3);
    if (!/^[a-f0-9]{40}$/.test(release.sourceCommit)) throw new Error('Invalid source commit');
    if (!/^[a-f0-9]{64}$/.test(release.openApi.sha256)) throw new Error('Invalid OpenAPI SHA-256');
    if (release.openApi.path.length === 0) throw new Error('An OpenAPI artifact path is required');
  }
  const selected = selectLatestReleaseVersions(
    input.supportedMinors,
    input.releases.map((release) => release.backstageVersion),
  );
  const releases = new Map(input.releases.map((release) => [release.backstageVersion, release]));
  return Object.freeze(
    selected.map((version) => {
      const release = releases.get(version)!;
      return Object.freeze({
        backstageVersion: release.backstageVersion,
        catalogBackendVersion: release.catalogBackendVersion,
        catalogModelVersion: release.catalogModelVersion,
        sourceCommit: release.sourceCommit,
        openApi: Object.freeze({ ...release.openApi }),
        minorLine: version.split('.').slice(0, 2).join('.'),
      });
    }),
  );
}
