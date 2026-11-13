import { randomUUID } from 'node:crypto';
import { validatePolicySources } from '../pipeline/policy-sources.js';
import type { PolicySourceContext } from '../pipeline/policy-sources.js';
import type { ValidationRequest } from '../contracts/schemas.js';
import { canonicalJson } from '../base/json.js';
import type { Immutable } from '../base/json.js';
import { capabilityBinding, capabilityAuthorityDigest } from '../capabilities/bindings.js';
import { builtinCapabilitySession } from '../capabilities/session.js';
import { CapabilityError } from '../capabilities/admission.js';

type Report = Awaited<ReturnType<typeof validatePolicySources>>;
type Options = NonNullable<Parameters<typeof validatePolicySources>[2]>;
const contribution = (report: Report) => ({
  materializedData: report.request.data,
  evaluatedAt: report.request.execution.startedAt,
  evaluationDataDigest: report.request.data.digest,
  findings: report.findings,
  coverage: report.coverage,
  ruleStates: report.ruleStates,
  interrupted: report.interrupted,
  artifacts: report.compatibility.artifacts,
});
/** The existing core produces the report. The capability boundary admits its portable projection. */
export class BuiltinValidationService {
  private readonly calls = new Map<string, { options: Options; report?: Report }>();
  readonly capabilities;
  /**
   * `defaults.runtime` and `defaults.clock` apply to every run whose options do not name their own;
   * the clock also decides the capability session's admission and reply deadlines.
   */
  constructor(
    context: PolicySourceContext,
    private readonly generation = 0,
    defaults: Pick<Options, 'runtime' | 'clock'> = {},
  ) {
    this.capabilities = builtinCapabilitySession(
      'bve.builtin.validation',
      {
        validation: async (input, request, execution) => {
          const call = this.calls.get(request.requestId);
          if (!call) throw new CapabilityError('not_approved');
          const report = await validatePolicySources(input.request, context, {
            ...defaults,
            ...call.options,
            signal: execution.signal,
          });
          call.report = report;
          return contribution(report);
        },
      },
      {
        async: ['validation'],
        required: ['validation'],
        dependencies: [context.profile.adapterId, context.profile.celProfileId],
        languageProfiles: [
          'host-contract/0.2',
          'bve-cel/1',
          'draft-07/bve/1',
          're2js@2.9.0/cel-v1',
          're2js@2.9.0/schema-v1',
        ],
        ...(defaults.clock ? { clock: defaults.clock } : {}),
      },
    );
  }
  async run(
    request: Immutable<ValidationRequest>,
    options: Options = {},
    state: {
      readonly workspaceGeneration: number;
      readonly dependencyGeneration?: number;
      readonly authorityContextDigest?: string;
      readonly current?: () => boolean;
    } = { workspaceGeneration: 0 },
  ): Promise<Report> {
    const requestId = randomUUID();
    const call: { options: Options; report?: Report } = { options };
    this.calls.set(requestId, call);
    try {
      const authorityContextDigest = capabilityAuthorityDigest(request.identity, options.catalog);
      if (state.authorityContextDigest && state.authorityContextDigest !== authorityContextDigest)
        throw new CapabilityError('binding');
      const result = await this.capabilities.provide(
        'validation',
        { request },
        {
          requestId,
          binding: capabilityBinding(request, {
            ...state,
            authorityContextDigest,
            sessionGeneration: this.generation,
          }),
          deadlineAt: request.execution.deadlineAt,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(state.current ? { current: state.current } : {}),
        },
      );
      const report = call.report;
      if (
        result.status !== 'ready' ||
        result.completeness !== 'complete' ||
        !report ||
        canonicalJson(result.value) !== canonicalJson(contribution(report))
      )
        throw new CapabilityError('binding');
      return report;
    } finally {
      this.calls.delete(requestId);
    }
  }
  close(): Promise<void> {
    return this.capabilities.close();
  }
}
