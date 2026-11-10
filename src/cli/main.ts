#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { open, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { parseContract } from '../contracts/validate.js';
import type { ValidationRequest } from '../contracts/schemas.js';
import { ContractError, reject } from '../core/errors.js';
import { canonicalJson, digestJson } from '../core/json.js';
import type { Immutable } from '../core/json.js';
import { createDataSnapshot } from '../core/snapshots.js';
import { resultExitCode } from '../core/results.js';
import { validatePolicySources } from '../core/policy-sources.js';
import { verifyPolicyRelease } from '../policy/releases.js';
import { createVerifiedPolicyResult } from '../policy/verified-result.js';
import { closeSharedCelRuntime } from '../runtime/cel/index.js';
import { createHostCatalog, parseCatalogSettings } from '../host/catalog-config.js';
import { formatSarif, formatSarifError } from './sarif.js';

const HELP = `Usage: bve validate --release RELEASE.json --trust HOST-TRUST.json
       (--source SNAPSHOT.json [--baseline SNAPSHOT.json] [--data DATA.json] | --request REQUEST.json)
       [--catalog-config HOST-CATALOG.json] [--format json|sarif] [--output PATH]

Validates immutable source snapshots using a signed policy release and separately
installed host trust. JSON is the contract-0.2 result; SARIF is version 2.1.0.
Exit codes: 0 allow/advisory, 1 completed blocking violation, 2 incomplete/error.
Explicit requests retain their original deadline. Source mode starts a fresh CI
budget after trusted configuration is loaded. Credentials use host environment.
`;

async function readJson(path: string): Promise<unknown> {
  const handle = await open(path, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error();
    const chunks: Buffer[] = [];
    let bytes = 0;
    const maximum = 32 * 1024 * 1024;
    while (bytes <= maximum) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maximum + 1 - bytes));
      const read = await handle.read(buffer);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      chunks.push(buffer.subarray(0, read.bytesRead));
    }
    if (bytes > maximum) reject('limit', '', 'input exceeds the file byte budget');
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

async function emit(value: unknown, path?: string) {
  const output = canonicalJson(value) + '\n';
  if (!path) {
    await new Promise<void>((done, fail) =>
      process.stdout.write(output, (error) => (error ? fail(error) : done())),
    );
    return;
  }
  const target = resolve(path);
  const temporary = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, output, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function main() {
  let format = 'json';
  let output: string | undefined;
  let catalog: Awaited<ReturnType<typeof createHostCatalog>>;
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const { values, positionals } = parseArgs({
      options: {
        help: { type: 'boolean', short: 'h' },
        source: { type: 'string' },
        baseline: { type: 'string' },
        data: { type: 'string' },
        request: { type: 'string' },
        release: { type: 'string' },
        trust: { type: 'string' },
        'catalog-config': { type: 'string' },
        format: { type: 'string' },
        output: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
    format = values.format ?? 'json';
    output = values.output;
    if (values.help) {
      process.stdout.write(HELP);
      return 0;
    }
    if (
      positionals.length !== 1 ||
      positionals[0] !== 'validate' ||
      !values.release ||
      !values.trust ||
      (format !== 'json' && format !== 'sarif') ||
      !!values.source === !!values.request ||
      (values.request && (values.baseline || values.data))
    )
      reject('invalid_contract', '', 'invalid CLI arguments');
    const [release, trust, input, baseline, data, catalogInput] = await Promise.all([
      readJson(values.release),
      readJson(values.trust),
      readJson((values.source ?? values.request)!),
      values.baseline ? readJson(values.baseline) : undefined,
      values.data ? readJson(values.data) : undefined,
      values['catalog-config'] ? readJson(values['catalog-config']) : undefined,
    ]);
    const context = verifyPolicyRelease(release, trust);
    const explicit = values.request ? parseContract('validation-request', input) : undefined;
    const source = explicit?.source ?? parseContract('source-snapshot', input);
    if (explicit && canonicalJson(explicit.identity) !== canonicalJson(context.identity))
      reject('integrity', '/identity', 'request identity differs from installed host trust');
    if (explicit && explicit.execution.mode !== 'ci')
      reject('invalid_contract', '/execution/mode', 'CLI requests must use CI mode');
    const previous =
      explicit?.baseline ??
      (baseline === undefined ? undefined : parseContract('source-snapshot', baseline));
    const snapshotData =
      explicit?.data ??
      (data === undefined ? createDataSnapshot([]) : parseContract('data-snapshot', data));
    if (catalogInput !== undefined) {
      catalog = await createHostCatalog(
        parseCatalogSettings(catalogInput),
        {
          adapterId: context.profile.adapterId,
          identity: context.identity,
          policyDigest: digestJson(context.policy),
          profileDigest: digestJson(context.profile),
        },
        process.env,
      );
    }
    const startedAt = Date.now();
    const request: Immutable<ValidationRequest> =
      explicit ??
      parseContract('validation-request', {
        contractVersion: '0.2',
        run: {
          runId: randomUUID(),
          attemptId: randomUUID(),
          generation: context.activation.generation,
        },
        execution: {
          mode: 'ci',
          startedAt,
          deadlineAt: startedAt + context.profile.limits.requestTimeoutMs,
        },
        identity: context.identity,
        source,
        ...(previous ? { baseline: previous } : {}),
        data: snapshotData,
        policy: { digest: digestJson(context.policy), revision: context.policy.revision },
        profile: { digest: digestJson(context.profile), id: context.profile.id },
        activation: {
          digest: digestJson(context.activation),
          generation: context.activation.generation,
        },
      });
    const report = await validatePolicySources(request, context, {
      ...(catalog ? { catalog } : {}),
      signal: cancellation.signal,
    });
    const result = createVerifiedPolicyResult(report, context);
    await emit(format === 'sarif' ? formatSarif(result) : result, output);
    return resultExitCode(result);
  } catch (error) {
    const code = error instanceof ContractError ? error.code : 'input_error';
    const value =
      format === 'sarif'
        ? formatSarifError(code)
        : {
            contractVersion: '0.2',
            outcome: 'error',
            enforcement: 'block',
            error: {
              code,
              message: 'Validation input or trusted configuration could not be loaded.',
            },
          };
    // If an output path itself fails, keep a machine-readable failure on stdout.
    await emit(value, output).catch(() => emit(value));
    return 2;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    try {
      await catalog?.provider.close();
    } finally {
      await closeSharedCelRuntime();
    }
  }
}

process.exitCode = await main();
