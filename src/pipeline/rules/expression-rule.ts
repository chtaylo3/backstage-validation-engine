import { ruleFinding } from './findings.js';
import type { RuleEvaluator, RuleOfKind } from './types.js';

/** Evaluates the rule's CEL expression; `false` is a completed violation. */
export const evaluateExpressionRule: RuleEvaluator<RuleOfKind<'cel'>> = async (
  context,
  rule,
  subject,
  record,
) => {
  if (await context.runtime.evaluate(rule.expression, subject.value, context.evaluation)) return;
  record.state.status = 'failed';
  record.findings.push(
    ruleFinding(context.run, rule, subject, {
      path: subject.location.path,
      message: 'Entity does not satisfy the policy rule.',
      dependency: false,
      location: subject.location,
      relatedLocations: [],
      edits: [],
    }),
  );
};
