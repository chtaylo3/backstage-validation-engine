import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createDataSnapshot, parseContract } from '../../src/index.js';
import type { CelRuntime, Coverage, Finding, RuleState } from '../../src/index.js';
import type { PolicySchemaValidator } from '../../src/compatibility/custom-schemas.js';
import type { CatalogBoundReference } from '../../src/pipeline/catalog-bindings.js';
import { evaluateCatalogRule } from '../../src/pipeline/rules/catalog-rule.js';
import { evaluateRule, RULE_EVALUATORS } from '../../src/pipeline/rules/dispatch.js';
import { evaluateExpressionRule } from '../../src/pipeline/rules/expression-rule.js';
import { evaluateSchemaRule } from '../../src/pipeline/rules/schema-rule.js';
import type {
  Rule,
  RuleEvaluator,
  RuleEvaluators,
  RuleOfKind,
  RuleRecord,
  RuleRunContext,
} from '../../src/pipeline/rules/types.js';
import type { RuleSubject } from '../../src/pipeline/types.js';
import { RequestBudget } from '../../src/runtime/request-budget.js';
import { policyRun } from '../harness/policy-fixture.js';
import { URI } from '../helpers.js';

type Mode = 'ci' | 'ide';
const budgets: RequestBudget[] = [];
after(() => {
  for (const budget of budgets) budget[Symbol.dispose]();
});

const subject: RuleSubject = {
  id: JSON.stringify([URI, 0]),
  value: { kind: 'Component', spec: { owner: 'team' } },
  location: {
    uri: URI,
    document: 0,
    path: '',
    range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } },
  },
};
/** A runtime that answers each expression from a table, without workers. */
const runtime = (answers: Readonly<Record<string, boolean>>): CelRuntime =>
  ({
    evaluate: (expression: string) => {
      const answer = answers[expression];
      return answer === undefined
        ? Promise.reject(new Error(`unexpected expression ${expression}`))
        : Promise.resolve(answer);
    },
  }) as unknown as CelRuntime;
const validator = (path: string | undefined): PolicySchemaValidator =>
  Object.assign(() => path, {
    issue: () => (path === undefined ? undefined : { path, keyword: 'required' }),
  });
const reference = (entityPath: string) => ({
  entityPath,
  sourceEntityRef: 'component:default/service',
  targetRef: 'group:default/team',
  value: 'team',
  contextPath: '/spec/owner',
  sourceDigest: 'sha256:' + '1'.repeat(64),
  location: { ...subject.location, path: entityPath },
  relatedLocations: [{ ...subject.location, path: '/related' }],
});

function context(
  mode: Mode,
  patch: Partial<Pick<RuleRunContext, 'runtime' | 'schemaValidators' | 'catalogBindings'>> = {},
): RuleRunContext {
  const run = parseContract('validation-request', {
    ...policyRun({ mode }).request,
    data: createDataSnapshot([]),
  });
  const budget = new RequestBudget(run.execution.deadlineAt);
  budgets.push(budget);
  return {
    run,
    budget,
    runtime: runtime({}),
    evaluation: { requestId: 'request', deadlineAt: run.execution.deadlineAt },
    schemaValidators: new Map(),
    documents: new Map(),
    substitutions: new Map(),
    catalogBindings: new Map(),
    fixes: { generated: 0, indexes: new Map() },
    ...patch,
  };
}
function record(rule: Rule): RuleRecord {
  const state: RuleState = {
    ruleId: rule.id,
    subjectId: subject.id,
    required: rule.mandatory,
    status: 'passed',
  };
  const coverage: Coverage = {
    stage: 'rules',
    subject: JSON.stringify([subject.id, rule.id]),
    required: rule.mandatory,
    status: 'verified',
  };
  return { state, coverage, findings: [], failures: [] };
}
async function run<R extends Rule>(
  evaluator: RuleEvaluator<R>,
  ruleContext: RuleRunContext,
  rule: R,
): Promise<RuleRecord> {
  const result = record(rule);
  await evaluator(ruleContext, rule, subject, result);
  return result;
}
const base = { version: '1', requires: [] } as const;
const cel = (patch: Partial<RuleOfKind<'cel'>> = {}): RuleOfKind<'cel'> => ({
  ...base,
  id: 'expression',
  kind: 'cel',
  mandatory: true,
  severity: 'error',
  expression: 'check',
  ...patch,
});
const schema = (patch: Partial<RuleOfKind<'schema'>> = {}): RuleOfKind<'schema'> => ({
  ...base,
  id: 'schema',
  kind: 'schema',
  mandatory: true,
  severity: 'error',
  schema: { id: 'example/schema', version: '1', digest: 'sha256:' + '2'.repeat(64) },
  ...patch,
});
const catalog = (patch: Partial<RuleOfKind<'catalog'>> = {}): RuleOfKind<'catalog'> => ({
  ...base,
  id: 'catalog',
  kind: 'catalog',
  mandatory: true,
  severity: 'error',
  check: 'exists',
  referencePath: '/spec/owner',
  ...patch,
});
const bound = (...facts: CatalogBoundReference['status'][]) =>
  new Map([
    [
      subject.id,
      new Map([
        ['/spec/owner', facts.map((status) => ({ reference: reference('/spec/owner'), status }))],
      ]),
    ],
  ]);
const verdict = (finding: Finding | undefined) => [
  finding?.category,
  finding?.severity,
  finding?.enforcement,
];

/** The enforcement formulas, stated independently of the implementation. */
const expected = (mode: Mode, rule: Rule, dependency: boolean) => [
  dependency ? 'dependency' : 'policy',
  dependency && mode === 'ide' ? 'warning' : rule.severity,
  mode === 'ci' && (dependency ? rule.mandatory : rule.mandatory || rule.severity === 'error')
    ? 'blocking'
    : 'advisory',
];
const variants = [
  { mandatory: true, severity: 'error' },
  { mandatory: false, severity: 'error' },
  { mandatory: false, severity: 'warning' },
  { mandatory: true, severity: 'warning' },
] as const;

void test('expression evaluator: pass, fail, and the policy finding formula in both modes', async () => {
  for (const mode of ['ci', 'ide'] as const) {
    const passed = await run(
      evaluateExpressionRule,
      context(mode, { runtime: runtime({ check: true }) }),
      cel(),
    );
    assert.equal(passed.state.status, 'passed');
    assert.deepEqual(
      [passed.findings, passed.failures, passed.coverage.status],
      [[], [], 'verified'],
    );
    for (const variant of variants) {
      const rule = cel(variant);
      const failed = await run(
        evaluateExpressionRule,
        context(mode, { runtime: runtime({ check: false }) }),
        rule,
      );
      assert.equal(failed.state.status, 'failed');
      assert.equal(failed.coverage.status, 'verified');
      assert.deepEqual(failed.failures, []);
      assert.equal(failed.findings.length, 1);
      assert.deepEqual(
        verdict(failed.findings[0]),
        expected(mode, rule, false),
        `${mode} ${JSON.stringify(variant)}`,
      );
      assert.equal(failed.findings[0]?.message, 'Entity does not satisfy the policy rule.');
      assert.deepEqual(failed.findings[0]?.location, subject.location);
    }
  }
});

void test('schema evaluator: pass, fail, dependency unavailable, and both finding formulas', async () => {
  for (const mode of ['ci', 'ide'] as const) {
    const ok = context(mode, { schemaValidators: new Map([['schema', validator(undefined)]]) });
    const passed = await run(evaluateSchemaRule, ok, schema());
    assert.deepEqual([passed.state.status, passed.findings.length], ['passed', 0]);
    for (const variant of variants) {
      const rule = schema(variant);
      const invalid = context(mode, {
        schemaValidators: new Map([['schema', validator('/spec/tier')]]),
      });
      const failed = await run(evaluateSchemaRule, invalid, rule);
      assert.deepEqual(
        [failed.state.status, failed.state.reason, failed.coverage.status],
        ['failed', undefined, 'verified'],
      );
      assert.deepEqual(failed.failures, []);
      assert.deepEqual(verdict(failed.findings[0]), expected(mode, rule, false));
      assert.equal(failed.findings[0]?.location.path, '/spec/tier');
      const missing = context(mode, { schemaValidators: new Map([['schema', undefined]]) });
      const unavailable = await run(evaluateSchemaRule, missing, rule);
      assert.deepEqual(
        [unavailable.state.status, unavailable.state.reason, unavailable.coverage.status],
        ['incomplete', 'dependency_unavailable', 'unavailable'],
      );
      assert.deepEqual(unavailable.failures, [
        { subjectId: subject.id, ruleId: 'schema', code: 'unsupported_rule' },
      ]);
      assert.deepEqual(
        verdict(unavailable.findings[0]),
        expected(mode, rule, true),
        `${mode} ${JSON.stringify(variant)}`,
      );
      assert.equal(
        unavailable.findings[0]?.message,
        'The pinned policy schema artifact is unavailable.',
      );
    }
  }
});

void test('catalog evaluator: present, missing, no references, unavailable or absent facts', async () => {
  for (const mode of ['ci', 'ide'] as const) {
    const passed = await run(
      evaluateCatalogRule,
      context(mode, { catalogBindings: bound('present', 'present') }),
      catalog(),
    );
    assert.deepEqual([passed.state.status, passed.findings.length], ['passed', 0]);
    const empty = await run(
      evaluateCatalogRule,
      context(mode, { catalogBindings: bound() }),
      catalog(),
    );
    assert.deepEqual([empty.state.status, empty.findings.length], ['not_applicable', 0]);
    for (const variant of variants) {
      const rule = catalog(variant);
      const failed = await run(
        evaluateCatalogRule,
        context(mode, { catalogBindings: bound('present', 'missing') }),
        rule,
      );
      assert.deepEqual(
        [failed.state.status, failed.coverage.status, failed.findings.length],
        ['failed', 'verified', 1],
      );
      assert.deepEqual(verdict(failed.findings[0]), expected(mode, rule, false));
      assert.deepEqual(failed.findings[0]?.relatedLocations, [
        { ...subject.location, path: '/related' },
      ]);
      for (const [bindings, coverage] of [
        [new Map(), 'blocked'],
        [bound('present', 'unavailable'), 'unavailable'],
        [bound('blocked'), 'blocked'],
      ] as const) {
        const unavailable = await run(
          evaluateCatalogRule,
          context(mode, { catalogBindings: bindings }),
          rule,
        );
        assert.deepEqual(
          [unavailable.state.status, unavailable.state.reason, unavailable.coverage.status],
          ['incomplete', 'dependency_unavailable', coverage],
        );
        assert.deepEqual(unavailable.failures, [
          { subjectId: subject.id, ruleId: 'catalog', code: 'catalog_unavailable' },
        ]);
        assert.deepEqual(
          verdict(unavailable.findings[0]),
          expected(mode, rule, true),
          `${mode} ${coverage}`,
        );
        assert.equal(
          unavailable.findings[0]?.message,
          'Catalog data is unavailable for this policy rule.',
        );
      }
    }
  }
});

void test('a selector that does not apply leaves every rule kind not applicable', async () => {
  for (const rule of [
    cel({ selector: 'applies' }),
    schema({ selector: 'applies' }),
    catalog({ selector: 'applies' }),
  ]) {
    const result = record(rule);
    await evaluateRule(
      context('ci', { runtime: runtime({ applies: false }) }),
      rule,
      subject,
      result,
    );
    assert.deepEqual(
      [result.state.status, result.findings, result.failures],
      ['not_applicable', [], []],
      rule.kind,
    );
  }
  const applies = record(cel({ selector: 'applies' }));
  await evaluateRule(
    context('ci', { runtime: runtime({ applies: true, check: false }) }),
    cel({ selector: 'applies' }),
    subject,
    applies,
  );
  assert.equal(applies.state.status, 'failed');
});

void test('every contract rule kind has exactly one registered evaluator', () => {
  // Compile-time: the table covers every kind, and a table without one does not compile.
  RULE_EVALUATORS satisfies Record<Rule['kind'], unknown>;
  // @ts-expect-error A rule kind without an evaluator is a compile error.
  const incomplete: RuleEvaluators = { cel: evaluateExpressionRule, schema: evaluateSchemaRule };
  assert(incomplete);
  const kinds: Rule['kind'][] = ['cel', 'schema', 'catalog'];
  assert.deepEqual(Object.keys(RULE_EVALUATORS).sort(), [...kinds].sort());
  assert.equal(RULE_EVALUATORS.cel, evaluateExpressionRule);
  assert.equal(RULE_EVALUATORS.schema, evaluateSchemaRule);
  assert.equal(RULE_EVALUATORS.catalog, evaluateCatalogRule);
});
