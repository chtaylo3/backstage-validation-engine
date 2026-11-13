import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import * as engine from '../../src/index.js';

const load = (file: string) => import(pathToFileURL(path.resolve(file)).href);
interface AuthorityEvidence {
  schemaVersion: number;
  policyDigest: string;
  profileDigest: string;
  activation: { activatedAt: number; generation: number };
  release: { issuedAt: number; expiresAt: number };
  trust: { maxAgeMs: number };
  bundleValidity: { present: boolean };
  constructionVerification: { verifiedAt: number; expiresAt: number };
}
const json = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));

void test('actual fixture construction retains sanitized authority inputs and effective expiry', async (t) => {
  const { createClientFixture, validText, invalidText } = (await load(
    'test/integration/backstage/lib/clients.mjs',
  )) as {
    createClientFixture: (options: {
      engine: typeof engine;
      directory: string;
      workspace: string;
      baseUrl: string;
      authorityReport: string;
      trustMaxAgeMs?: number;
    }) => Promise<{ policy: engine.PolicyBundle; sourceFile: string; configPath: string }>;
    validText: string;
    invalidText: string;
  };
  const root = await mkdtemp(path.join(tmpdir(), 'bve-authority-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retained: [string, string][] = [];
  for (const maxAgeMs of [3_600_000, 60_000]) {
    const directory = path.join(root, String(maxAgeMs), 'trusted');
    const authorityReport = path.join(root, String(maxAgeMs), 'reports', 'authority.json');
    const fixture = await createClientFixture({
      engine,
      directory,
      workspace: path.join(root, String(maxAgeMs), 'proposals'),
      baseUrl: 'http://synthetic-backstage:7007',
      authorityReport,
      trustMaxAgeMs: maxAgeMs,
    });
    for (const [filename, contents] of retained)
      assert.equal(await readFile(filename, 'utf8'), contents);
    retained.push([authorityReport, await readFile(authorityReport, 'utf8')]);
    const release = engine.parseContract(
      'policy-release',
      await json(path.join(directory, 'release.json')),
    );
    const trust = engine.parseContract(
      'policy-trust',
      await json(path.join(directory, 'trust.json')),
    );
    const evidence = (await json(authorityReport)) as AuthorityEvidence;
    const context = engine.verifyPolicyRelease(
      release,
      trust,
      evidence.constructionVerification.verifiedAt,
    );
    assert.deepEqual(evidence, {
      schemaVersion: 1,
      policyDigest: engine.digestJson(context.policy),
      profileDigest: engine.digestJson(context.profile),
      activation: {
        activatedAt: release.activation.activatedAt,
        generation: release.activation.generation,
      },
      release: { issuedAt: release.issuedAt, expiresAt: release.expiresAt },
      trust: { maxAgeMs },
      bundleValidity: { present: false },
      constructionVerification: {
        verifiedAt: context.verification.verifiedAt,
        expiresAt: Math.min(release.expiresAt, release.issuedAt + maxAgeMs),
      },
    });
    assert.equal(release.expiresAt - release.issuedAt, 3_600_000);
    assert.equal(evidence.constructionVerification.expiresAt - release.issuedAt, maxAgeMs);
    assert.throws(
      () => engine.verifyPolicyRelease(release, trust, evidence.constructionVerification.expiresAt),
      /trusted validity window/u,
    );
    assert.equal(await readFile(fixture.sourceFile, 'utf8'), invalidText);
    assert.equal(
      validText.replace('lifecycle: production', 'lifecycle: experimental'),
      invalidText,
    );
    assert.throws(() =>
      engine.parseContract('policy-bundle', { ...fixture.policy, expiresAt: release.expiresAt }),
    );
    const serialized = JSON.stringify(evidence);
    for (const forbidden of [
      root,
      'BEGIN PUBLIC KEY',
      'BEGIN PRIVATE KEY',
      release.signature.value,
      'tokenEnv',
      'baseUrl',
      'synthetic-backstage:7007',
      'keys',
      'signature',
      'filesystem',
    ])
      assert(
        !serialized.includes(forbidden),
        'Evidence must omit secret material and private construction details.',
      );
    assert.equal(typeof (await json(fixture.configPath)), 'object');
  }
});

void test('versioned installed inventory uses the actual portable selector without a qualification claim', async () => {
  const { selectInstalledModules } = (await load('scripts/extension-test-selection.mjs')) as {
    selectInstalledModules: (
      modules: string[],
      options?: {
        focused?: string;
        racesOnly?: boolean;
        trustOnly?: boolean;
        compatibility?: boolean;
        endurance?: boolean;
        soak?: boolean;
      },
    ) => string[];
  };
  const independent = (await json('test/fixtures/installed-inventory-controls.json')) as {
    modules: string[];
    portable: string[];
  };
  const modules = (await readdir('extensions/vscode/test/cases'))
    .filter((name) => name.endsWith('.case.ts'))
    .map((name) => name.replace(/\.ts$/u, '.cjs'))
    .sort();
  assert.deepEqual(modules, independent.modules);
  assert.equal(modules.length, 58);
  assert.deepEqual(selectInstalledModules(modules), independent.portable);
  assert.equal(selectInstalledModules(modules).length, 50);
  const ids = modules.map((name) => name.replace(/\.case\.cjs$/u, ''));
  assert.deepEqual(
    selectInstalledModules(ids),
    independent.portable.map((name) => name.replace(/\.case\.cjs$/u, '')),
  );
  assert.deepEqual(
    selectInstalledModules(ids, { racesOnly: true }),
    selectInstalledModules(modules, { racesOnly: true }).map((name) =>
      name.replace(/\.case\.cjs$/u, ''),
    ),
  );
  for (const [options, prefix] of [
    [{ trustOnly: true }, 'trust-'],
    [{ compatibility: true }, 'compat-'],
    [{ soak: true }, 'endurance-soak.'],
  ] as const)
    assert.deepEqual(
      selectInstalledModules(modules, options),
      modules.filter((name) => name.startsWith(prefix)),
    );
  assert.deepEqual(
    selectInstalledModules(modules, { focused: 'race-dirty-watch,config-missing' }),
    ['config-missing.case.cjs', 'race-dirty-watch.case.cjs'],
  );
  assert.deepEqual(selectInstalledModules(modules.slice(1)), independent.portable.slice(1));
});

void test('optional screenshot failures cannot hide independent workbench action failures', async (t) => {
  const { Workbench } = (await load('scripts/extension-test-ui.mjs')) as {
    Workbench: new (socket: { addEventListener: () => void }) => {
      call: () => Promise<unknown>;
      screenshot: (file: string) => Promise<{ role: string; status: string }>;
      evaluate: (expression: string) => Promise<unknown>;
    };
  };
  const root = await mkdtemp(path.join(tmpdir(), 'bve-screenshot-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const browser = new Workbench({ addEventListener() {} });
  browser.call = () =>
    Promise.resolve({ data: Buffer.from('optional diagnostic bytes').toString('base64') });
  const file = path.join(root, 'diagnostic.png');
  assert.deepEqual(await browser.screenshot(file), {
    role: 'optional-diagnostic',
    status: 'captured',
  });
  assert.equal(await readFile(file, 'utf8'), 'optional diagnostic bytes');
  browser.call = () => Promise.reject(new Error('controlled CDP failure'));
  assert.deepEqual(await browser.screenshot(file), {
    role: 'optional-diagnostic',
    status: 'unavailable',
  });
  await assert.rejects(browser.evaluate('document.body.innerText'), /controlled CDP failure/u);
});
