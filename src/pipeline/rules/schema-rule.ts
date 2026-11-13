import { locateParsedPath } from '../../parsing/locations.js';
import { scalarConstEdit, SCALAR_FIX_LIMITS } from '../scalar-fixes.js';
import { ruleFinding } from './findings.js';
import type { RuleEvaluator, RuleOfKind } from './types.js';

/** Validates the subject against the rule's pinned schema artifact. */
export const evaluateSchemaRule: RuleEvaluator<RuleOfKind<'schema'>> = (
  context,
  rule,
  subject,
  record,
): undefined => {
  const { budget, fixes, run } = context;
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
  // Lanes share one generation budget, so a fix is counted before the interruption check.
  const edit =
    !dependency && fixes.generated < SCALAR_FIX_LIMITS.generated
      ? scalarConstEdit(
          run,
          document,
          subject.value,
          issue,
          context.substitutions.get(subject.id) ?? [],
          fixes.indexes,
        )
      : undefined;
  if (edit) fixes.generated++;
  budget.throwIfInterrupted();
  record.findings.push(
    ruleFinding(run, rule, subject, {
      path: pointer,
      message: dependency
        ? 'The pinned policy schema artifact is unavailable.'
        : 'Entity does not satisfy the policy schema.',
      dependency,
      location,
      relatedLocations: document?.locations[nearest]?.relatedLocations ?? [],
      edits: edit ? [edit] : [],
    }),
  );
};
