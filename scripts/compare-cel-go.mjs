import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ManagedCelPool } from '../.test-dist/src/runtime/cel/pool.js';
import { CelError } from '../.test-dist/src/runtime/cel/errors.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const historical = await readFile('test/fixtures/cel-qualification.json');
const sidecar = await readFile('test/fixtures/cel-qualification-v2.json');
assert.equal(hash(sidecar), '09884eddbbf1468a446c27a12e932ecac3f0e32923624aae532b1cae01cd1377');
const revision = JSON.parse(sidecar);
assert.equal(hash(historical), revision.historicalCorpusSha256);
const cases = [...JSON.parse(historical), ...revision.additions];
assert.equal(cases.length, 61);
const go = process.env.GO_BINARY ?? 'go';
const env = { ...process.env, GOTOOLCHAIN: 'local' };
const toolchain = execFileSync(go, ['version'], { env, encoding: 'utf8' }).trim();
assert.match(toolchain, /^go version go1\.26\.11 /);
const module = JSON.parse(
  execFileSync(go, ['list', '-m', '-json', 'github.com/google/cel-go'], {
    cwd: 'scripts/cel-go',
    env,
    encoding: 'utf8',
  }),
);
assert.equal(module.Version, 'v0.26.1');
const output = execFileSync(go, ['run', '-mod=readonly', '.'], {
  cwd: 'scripts/cel-go',
  env,
  input: JSON.stringify(cases),
  encoding: 'utf8',
  timeout: 120000,
});
const independent = JSON.parse(output);
assert.equal(independent.length, cases.length);
const pool = new ManagedCelPool();
const rows = [];
try {
  await pool.warm();
  for (const [index, vector] of cases.entries()) {
    const expectedBve =
      vector.expected === 'error'
        ? (vector.errorCode ?? revision.errorCodes[vector.name])
        : vector.expected;
    assert.notEqual(expectedBve, undefined, `${vector.name}: fixed BVE expectation required`);
    const difference = revision.differences.find((row) => row.name === vector.name);
    const expectedGo = difference
      ? difference.goExpected
      : vector.expected === 'error'
        ? revision.goErrorOutcomes[vector.name]
        : vector.expected;
    assert.notEqual(
      expectedGo,
      undefined,
      `${vector.name}: fixed independent expectation required`,
    );
    assert.equal(independent[index].name, vector.name);
    assert.equal(independent[index].outcome, expectedGo, `${vector.name}: CEL-Go outcome`);
    if (vector.name === 'non_boolean_result') {
      assert.equal(independent[index].rawType, 'int');
      assert.equal(independent[index].rawValue, 2);
    }
    let actual;
    try {
      actual = await pool.evaluate(vector.expression, vector.entity, {
        requestId: 'comparison',
        deadlineAt: Date.now() + 5000,
      });
    } catch (error) {
      assert(error instanceof CelError);
      actual = error.code;
    }
    assert.equal(actual, expectedBve, `${vector.name}: BVE outcome`);
    rows.push({
      name: vector.name,
      bve: actual,
      celGo: independent[index].outcome,
      ...(independent[index].rawType
        ? { celGoValue: { type: independent[index].rawType, value: independent[index].rawValue } }
        : {}),
      disposition:
        difference?.reason ??
        'Reviewed boolean agreement or exact declared error-stage correspondence.',
    });
  }
} finally {
  await pool.close();
}
const report = {
  sourceDirty:
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      encoding: 'utf8',
    }).trim() !== '',
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  toolchain,
  celGo: {
    version: module.Version,
    sum: module.Sum,
    revision: '8e7beb65e9a70f501fd743c3b70b2a0a2fadac52',
  },
  toolchainArchive: {
    file: 'go1.26.11.linux-amd64.tar.gz',
    sha256: '9849f4e04ee35303714e34fbc3ac8ab44ea3e448a95aa182f91e3b9b79c710ec',
  },
  inputNumberAdapter:
    'Go encoding/json float64 values map to CEL doubles. Original expression text is unchanged.',
  historicalSha256: hash(historical),
  sidecarSha256: hash(sidecar),
  moduleLockSha256: hash(await readFile('scripts/cel-go/go.sum')),
  passed: rows.length,
  reviewedDifferences: revision.differences.length,
  rows,
};
const target = process.argv[2] ?? '.artifacts/cel-comparison/report.json';
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(report, null, 2) + '\n');
console.log(
  `CEL-Go ${module.Version}: ${rows.length} reviewed comparisons passed; ${revision.differences.length} explicit profile difference.`,
);
