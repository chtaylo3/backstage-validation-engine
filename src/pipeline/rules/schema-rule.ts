import { locateParsedPath } from '../../parsing/locations.js';
import { ruleFinding } from './findings.js';
import type { RuleEvaluator, RuleOfKind } from './types.js';

/**
 * Validates the subject against the rule's pinned schema artifact. A failed finding is recorded
 * without an edit, beside a fix candidate; the step after the lanes assigns generated fixes.
 */
export const evaluateSchemaRule: RuleEvaluator<RuleOfKind<'schema'>> = (
  context,
  rule,
  subject,
  record,
): undefined => {
  const { budget, run } = context;
  const validate = context.schemaValidators.get(rule.id);
  const issue = validate?.issue(subject.value);
  const path = validate ? issue?.path : '';
  budget.throwIfInterrupted();
  if (validate && path === undefined) return;
  const dependency = !validate;
  record.state.status = dependency ? 'incomplete' : 'failed';
  if (dependency) {
    record.state.reason = 'dependency_unavailable';
    record.coverage.status = 'unavailable';
    record.coverage.reason = 'The pinned policy schema artifact is unavailable.';
    record.failures.push({ subjectId: subject.id, ruleId: rule.id, code: 'unsupported_rule' });
  }
  const pointer = path ?? '';
  const document = context.documents.get(subject.id);
  let nearest = pointer;
  while (document && !document.locations[nearest] && nearest)
    nearest = nearest.slice(0, nearest.lastIndexOf('/'));
  const location = document
    ? locateParsedPath(document, pointer)
    : { ...subject.location, path: pointer };
  budget.throwIfInterrupted();
  const finding = ruleFinding(run, rule, subject, {
    path: pointer,
    message: dependency
      ? 'The pinned policy schema artifact is unavailable.'
      : 'Entity does not satisfy the policy schema.',
    dependency,
    location,
    relatedLocations: document?.locations[nearest]?.relatedLocations ?? [],
    edits: [],
  });
  record.findings.push(finding);
  if (!dependency)
    record.candidates.push({
      rule,
      subject,
      finding,
      issue,
      document,
      substitutions: context.substitutions.get(subject.id) ?? [],
    });
};
