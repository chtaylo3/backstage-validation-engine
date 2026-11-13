import type {
  DeploymentProfile,
  PolicyBundle,
  SchemaArtifact,
  ValidationRequest,
} from '../../contracts/schemas.js';
import { orderRules } from '../../contracts/rule-graph.js';
import { reject } from '../../base/errors.js';
import type { Immutable } from '../../base/json.js';
import { createSchemaRegistry } from '../../compatibility/custom-schemas.js';
import type { SourceLineIndex } from '../../parsing/locations.js';
import type { ParsedSourceDocument } from '../../parsing/types.js';
import { getSharedCelRuntime } from '../../runtime/cel/index.js';
import type { CelRuntime } from '../../runtime/cel/index.js';
import { CelError } from '../../runtime/cel/errors.js';
import type { RequestBudget } from '../../runtime/request-budget.js';
import { bindCatalogReferences } from '../catalog-bindings.js';
import type { CatalogBindings } from '../catalog-bindings.js';
import type { RuleSubject } from '../types.js';
import type { Rule, RuleExecutionOptions, RuleRunContext } from './types.js';

/**
 * The documented default runtime of rule execution when a caller supplies none: the process-wide
 * shared runtime. This module is the only engine module below the composition roots that may name
 * it; other components receive a runtime from their owner.
 */
export function defaultRuleRuntime(): CelRuntime {
  return getSharedCelRuntime();
}

/**
 * Resolves the run-level inputs of rule execution in dependency order: schema validators, source
 * provenance, the rule graph, and catalog bindings. Rejections keep the order of these checks.
 */
export async function prepareRuleRun(
  run: Immutable<ValidationRequest>,
  profile: Immutable<DeploymentProfile>,
  policy: Immutable<PolicyBundle>,
  subjects: readonly RuleSubject[],
  budget: RequestBudget,
  schemaArtifacts: readonly Immutable<SchemaArtifact>[] | undefined,
  options: RuleExecutionOptions,
): Promise<{ readonly context: RuleRunContext; readonly rules: readonly Rule[] }> {
  const schemas = createSchemaRegistry(schemaArtifacts);
  const schemaValidators = new Map(
    policy.rules
      .filter((rule) => rule.kind === 'schema')
      .map((rule) => [rule.id, schemas.get(rule.schema)]),
  );
  const sourceFiles = new Map(run.source.files.map((file) => [file.uri, file]));
  const documents = new Map<string, ParsedSourceDocument>();
  for (const document of options.sourceDocuments ?? []) {
    const file = sourceFiles.get(document.uri);
    if (!file || file.digest !== document.sourceDigest || file.version !== document.version)
      reject('integrity', '/sourceDocuments', 'rule source provenance does not match the snapshot');
    documents.set(JSON.stringify([document.uri, document.document]), document);
  }
  const substitutions = new Map(
    options.sourceSubstitutions?.map((row) => [row.subjectId, row.substitutions]),
  );
  const fixes = { generated: 0, indexes: new Map<string, SourceLineIndex>() };
  const rulesById = new Map(policy.rules.map((rule) => [rule.id, rule]));
  const rules = orderRules(policy.rules, profile.limits.graphDepth).map((id) => {
    const rule = rulesById.get(id);
    if (!rule) throw new Error('Rule graph invariant violated');
    return rule;
  });
  const runtime = options.runtime ?? defaultRuleRuntime();
  const catalogPaths = [
    ...new Set(
      policy.rules.filter((rule) => rule.kind === 'catalog').map((rule) => rule.referencePath),
    ),
  ];
  let catalogBindings: CatalogBindings = new Map();
  try {
    if (catalogPaths.length)
      catalogBindings = await bindCatalogReferences(
        run,
        profile,
        subjects,
        catalogPaths,
        options.referenceData,
        budget,
      );
  } catch (error) {
    if (!(error instanceof CelError) || !budget.interrupted) throw error;
  }
  const evaluation = {
    requestId: JSON.stringify([
      run.identity.installationId,
      run.identity.repositoryId,
      run.run.runId,
      run.run.attemptId,
      run.run.generation,
    ]),
    deadlineAt: run.execution.deadlineAt,
    signal: budget.signal,
    executionMs: profile.limits.celExecutionMs,
  };
  return {
    context: {
      run,
      budget,
      runtime,
      evaluation,
      schemaValidators,
      documents,
      substitutions,
      catalogBindings,
      fixes,
    },
    rules,
  };
}
