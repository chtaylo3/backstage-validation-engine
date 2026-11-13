import { setImmediate as turn } from 'node:timers/promises';
import { stringify } from 'yaml';
import { createSourceSnapshot, digestJson, parseContract } from '../../src/index.js';
import type {
  CelRuntime,
  DeploymentProfile,
  Finding,
  Immutable,
  JsonValue,
  PolicyBundle,
  SchemaArtifact,
} from '../../src/index.js';
import type { RuleSubject } from '../../src/pipeline/types.js';
import { ManualClock } from './manual-clock.js';
import { policyRun } from './policy-fixture.js';

/** The wall time of every run in these fixtures; a `ManualClock` keeps it fixed. */
export const T0 = 1_700_000_000_000;
export const ROOT = 'file:///workspace/';
export const clock = () => new ManualClock(T0, 1000);

/** The order in which a controlled runtime settles the evaluations that are waiting. */
export type SettleOrder = 'ascending' | 'descending' | { readonly seed: number };
export const ORDERS: readonly SettleOrder[] = ['ascending', 'descending', { seed: 7 }];

/** A small deterministic generator for the seeded order. */
function generator(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
}

export interface Evaluation {
  readonly expression: string;
  /** `metadata.name` of the evaluated entity, or its `id` for a direct subject. */
  readonly name: string;
}
/** Answers one evaluation: a boolean result, or a thrown value that the evaluation rejects with. */
export type Answer = (evaluation: Evaluation) => boolean | { readonly throws: Error };

const nameOf = (entity: unknown): string => {
  const value = entity as { metadata?: { name?: string }; id?: string } | null;
  return value?.metadata?.name ?? value?.id ?? '';
};

/**
 * A `CelRuntime` without workers whose evaluations wait until the runtime settles them. After every
 * macrotask turn (all lanes have then reached their next evaluation) it settles one waiting
 * evaluation, chosen by `order` from the entity names, so the order in which lanes resume is the
 * test's choice and does not depend on timing.
 */
export function controlledRuntime(answer: Answer, order: SettleOrder = 'ascending') {
  const random = typeof order === 'object' ? generator(order.seed) : undefined;
  const waiting: { evaluation: Evaluation; settle: () => void }[] = [];
  const calls: Evaluation[] = [];
  let scheduled = false;
  const pick = () => {
    if (random) return Math.floor(random() * waiting.length);
    let best = 0;
    for (let index = 1; index < waiting.length; index++) {
      const a = waiting[index]!.evaluation.name;
      const b = waiting[best]!.evaluation.name;
      if (order === 'ascending' ? a < b : a > b) best = index;
    }
    return best;
  };
  const schedule = () => {
    if (scheduled || !waiting.length) return;
    scheduled = true;
    void turn().then(() => {
      scheduled = false;
      const [next] = waiting.splice(pick(), 1);
      next?.settle();
      schedule();
    });
  };
  const runtime = {
    evaluate: (expression: string, entity: unknown) =>
      new Promise<boolean>((resolve, reject) => {
        const evaluation = { expression, name: nameOf(entity) };
        calls.push(evaluation);
        waiting.push({
          evaluation,
          settle: () => {
            const result = answer(evaluation);
            if (typeof result === 'boolean') resolve(result);
            else reject(result.throws);
          },
        });
        schedule();
      }),
    warm: () => Promise.resolve(),
    close: () => Promise.resolve(),
    stats: () => ({ workers: 0, active: 0, queued: 0, pending: 0, workerStarts: 0, closed: false }),
  } satisfies CelRuntime;
  return { runtime, calls };
}

/** A schema artifact with its own ID, so that one policy can pin several. */
export function namedArtifact(id: string, schema: JsonValue): Immutable<SchemaArtifact> {
  return parseContract('schema-artifact', {
    contractVersion: '0.2',
    id,
    version: '1',
    digest: digestJson(schema),
    schema,
  });
}

/** A schema rule pinned to `artifact`, optionally behind a selector. */
export function schemaRule(
  id: string,
  artifact: Immutable<SchemaArtifact>,
  patch: Partial<PolicyBundle['rules'][number]> = {},
): PolicyBundle['rules'][number] {
  return {
    id,
    version: '1',
    kind: 'schema',
    mandatory: true,
    severity: 'error',
    requires: [],
    schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
    ...patch,
  } as PolicyBundle['rules'][number];
}

export const componentName = (index: number) => `s-${String(index).padStart(3, '0')}`;
/** A valid Component document whose fields the caller may override. */
export function componentDocument(
  index: number,
  spec: Record<string, JsonValue> = {},
  metadata: Record<string, JsonValue> = {},
): string {
  return stringify({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: { name: componentName(index), ...metadata },
    spec: { type: 'service', lifecycle: 'experimental', owner: 'team', ...spec },
  });
}

/**
 * A CI run over one file per text, in index order, on the fixed clock. `profile` patches the
 * deployment profile's limits and fields.
 */
export function sourceRun(
  texts: readonly string[],
  rules: readonly PolicyBundle['rules'][number][],
  schemaArtifacts: readonly Immutable<SchemaArtifact>[],
  options: {
    readonly mode?: 'ci' | 'ide';
    readonly profile?: Partial<DeploymentProfile>;
    readonly lanes?: number;
  } = {},
) {
  const base = policyRun();
  const limits = base.context.profile.limits;
  const run = policyRun({
    mode: options.mode ?? 'ci',
    rules,
    schemaArtifacts,
    profile: {
      ...options.profile,
      limits: {
        ...limits,
        ...(options.lanes === undefined ? {} : { celWorkers: options.lanes }),
        ...options.profile?.limits,
      },
    },
    source: createSourceSnapshot({
      repository: 'repository',
      revision: '1',
      files: texts.map((text, index) => ({
        uri: `${ROOT}${componentName(index)}.yaml`,
        text,
        version: 1,
        origin: 'buffer' as const,
      })),
    }),
  });
  const request = parseContract('validation-request', {
    ...run.request,
    execution: { ...run.request.execution, startedAt: T0, deadlineAt: T0 + 5000 },
  });
  return { request, context: run.context };
}

/** Direct rule-stage subjects named `s-000`, `s-001`, ... in sorted order. */
export function directSubjects(count: number): RuleSubject[] {
  return Array.from({ length: count }, (_, index) => {
    const uri = `${ROOT}${componentName(index)}.yaml`;
    return {
      id: JSON.stringify([uri, 0]),
      value: { kind: 'Component', metadata: { name: componentName(index) } },
      location: {
        uri,
        document: 0,
        path: '',
        range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } },
      },
    };
  });
}

/** The entity name of a finding's subject (`[uri, document]`). */
export const findingName = (finding: Pick<Finding, 'subjectId'>) =>
  (JSON.parse(finding.subjectId) as [string, number])[0].slice(ROOT.length).replace('.yaml', '');

/** Waits until `condition` holds, one macrotask turn at a time; never on wall time. */
export async function until(condition: () => boolean, turns = 10_000): Promise<void> {
  for (let index = 0; index < turns && !condition(); index++) await turn();
  if (!condition()) throw new Error('condition not reached');
}
