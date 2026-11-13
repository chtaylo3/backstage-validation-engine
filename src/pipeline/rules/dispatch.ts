import type { RuleSubject } from '../types.js';
import { evaluateCatalogRule } from './catalog-rule.js';
import { evaluateExpressionRule } from './expression-rule.js';
import { evaluateSchemaRule } from './schema-rule.js';
import type {
  Rule,
  RuleEvaluator,
  RuleEvaluators,
  RuleOfKind,
  RuleRecord,
  RuleRunContext,
} from './types.js';

/** One evaluator per rule kind. A rule kind added to the contract does not compile until it has one. */
export const RULE_EVALUATORS: RuleEvaluators = Object.freeze({
  cel: evaluateExpressionRule,
  schema: evaluateSchemaRule,
  catalog: evaluateCatalogRule,
});

function evaluatorFor<K extends Rule['kind']>(kind: K): RuleEvaluator<RuleOfKind<K>> {
  return RULE_EVALUATORS[kind];
}

async function evaluateSelected(
  context: RuleRunContext,
  rule: Rule,
  selector: string,
  subject: RuleSubject,
  record: RuleRecord,
): Promise<void> {
  if (!(await context.runtime.evaluate(selector, subject.value, context.evaluation)))
    record.state.status = 'not_applicable';
  else await evaluatorFor(rule.kind)(context, rule, subject, record);
}

/**
 * Evaluates one rule for one subject: a selector that does not apply leaves the rule
 * `not_applicable`; otherwise the rule kind's evaluator records the result.
 */
export function evaluateRule(
  context: RuleRunContext,
  rule: Rule,
  subject: RuleSubject,
  record: RuleRecord,
): Promise<void> | undefined {
  context.budget.throwIfInterrupted();
  return rule.selector
    ? evaluateSelected(context, rule, rule.selector, subject, record)
    : evaluatorFor(rule.kind)(context, rule, subject, record);
}
