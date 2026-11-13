import type { Finding } from '../../contracts/schemas.js';
import type { Immutable } from '../../base/json.js';
import { ruleFinding } from './findings.js';
import type { RuleEvaluator, RuleOfKind } from './types.js';

/** Checks that every reference at the rule's path is present in the pinned catalog facts. */
export const evaluateCatalogRule: RuleEvaluator<RuleOfKind<'catalog'>> = (
  context,
  rule,
  subject,
  record,
): undefined => {
  const facts = context.catalogBindings.get(subject.id)?.get(rule.referencePath);
  const unavailable = facts?.find(
    (fact) =>
      fact.status === 'unavailable' ||
      fact.status === 'blocked' ||
      (fact.expiresAt !== undefined && fact.expiresAt <= context.budget.clock.wall()),
  );
  const addFinding = (
    location: Immutable<Finding['location']>,
    relatedLocations: readonly Immutable<Finding['location']>[],
    dependency: boolean,
    entityPath: string = location.path,
  ) =>
    record.findings.push(
      ruleFinding(context.run, rule, subject, {
        path: entityPath,
        message: dependency
          ? 'Catalog data is unavailable for this policy rule.'
          : 'Referenced entity is absent from the proposed catalog view.',
        dependency,
        location,
        relatedLocations,
        edits: [],
      }),
    );
  if (!facts || unavailable) {
    record.state.status = 'incomplete';
    record.state.reason = 'dependency_unavailable';
    record.coverage.status = unavailable?.status === 'unavailable' ? 'unavailable' : 'blocked';
    record.coverage.reason = 'Catalog observations required by the policy are unavailable.';
    record.failures.push({ subjectId: subject.id, ruleId: rule.id, code: 'catalog_unavailable' });
    addFinding(
      unavailable?.reference.location ?? subject.location,
      unavailable?.reference.relatedLocations ?? [],
      true,
      unavailable?.reference.entityPath ?? subject.location.path,
    );
  } else if (!facts.length) record.state.status = 'not_applicable';
  else {
    const missing = facts.filter((fact) => fact.status === 'missing');
    if (missing.length) record.state.status = 'failed';
    for (const fact of missing)
      addFinding(
        fact.reference.location,
        fact.reference.relatedLocations,
        false,
        fact.reference.entityPath,
      );
  }
};
