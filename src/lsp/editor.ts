import type {
  CompletionList,
  CompletionParams,
  Hover,
  Location,
  Position,
} from 'vscode-languageserver/node';
import type { Immutable } from '../base/json.js';
import { builtinMetadataSession } from '../capabilities/builtin-metadata.js';
import type { CapabilitySession } from '../capabilities/session.js';
import type { Finding, JsonValue, ValidationRequest } from '../contracts/schemas.js';
import type { PreparedRuleMetadata } from '../host/rule-contributions.js';
import type { validatePolicySources } from '../pipeline/policy-sources.js';
import type { LspConfig } from './config.js';
import { acceptsReference, complete, SelectionHistory } from './editor/completion.js';
import { invalidateIndex, refineIndex, updateIndex } from './editor/index-store.js';
import { definition, hover } from './editor/navigation.js';
import { repairs } from './editor/repairs.js';
import {
  expireRules,
  installRuleContributions,
  renderRuleCandidate,
  ruleExpiresAt,
  rulePreparationExpired,
  ruleRepairs,
} from './editor/rules.js';
import { EditorState } from './editor/state.js';
import type { CapabilityOptions } from './editor/state.js';
import { nativeEditorSchemas } from './editor-schemas.js';
import type { FixDocument, SuggestedFix } from './fixes.js';

/**
 * Bounded, generation-scoped editor metadata, separate from authoritative validation. The facade
 * owns the shared state; indexing, rule contributions, completion, navigation and repairs live in
 * `./editor/`.
 */
export class EditorService {
  private readonly state: EditorState;
  private readonly history = new SelectionHistory();
  readonly capabilities: CapabilitySession;
  constructor(
    config: LspConfig,
    schemaLoader: typeof nativeEditorSchemas = nativeEditorSchemas,
    capabilityOptions: CapabilityOptions = {},
  ) {
    this.capabilities =
      capabilityOptions.provider ??
      builtinMetadataSession(
        [
          config.profile.adapterId,
          ...config.schemaArtifacts.map(
            (artifact) => `${artifact.id}@${artifact.version}:${artifact.digest}`,
          ),
          ...config.editorArtifacts.map((artifact) => `${artifact.id}:${artifact.digest}`),
        ],
        capabilityOptions.clock,
      );
    this.state = new EditorState(config, this.capabilities, capabilityOptions);
    try {
      this.state.native = schemaLoader(config);
    } catch {
      this.state.native = new Map();
    }
  }
  invalidate(): void {
    invalidateIndex(this.state);
  }
  record(value: string): void {
    this.history.record(value);
  }
  update(request: Immutable<ValidationRequest>, generation: number): Promise<void> {
    return updateIndex(this.state, request, generation);
  }
  /** Refine advisory schemas with actual rule applicability and qualified structured includes. */
  refine(
    report: Awaited<ReturnType<typeof validatePolicySources>>,
    generation: number,
  ): Promise<void> {
    return refineIndex(this.state, report, generation);
  }
  installRuleContributions(rows: readonly PreparedRuleMetadata[], generation: number): void {
    installRuleContributions(this.state, rows, generation);
  }
  get rulePreparationExpired(): boolean {
    return rulePreparationExpired(this.state);
  }
  /** A new request can renew optional proofs while pure local metadata remains advisory. */
  expireRules(generation: number): void {
    expireRules(this.state, generation);
  }
  get ruleExpiresAt(): number {
    return ruleExpiresAt(this.state);
  }
  ruleRepairs(generation: number, documents: ReadonlyMap<string, FixDocument>): SuggestedFix[] {
    return ruleRepairs(this.state, generation, documents);
  }
  /** Render only a qualified scalar or an unambiguous map insertion in one authored file. */
  renderRuleCandidate(
    subjectId: string,
    path: string,
    value: JsonValue,
    ruleId: string,
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
    findings: readonly Immutable<Finding>[],
  ): Immutable<Finding> | undefined {
    return renderRuleCandidate(
      this.state,
      subjectId,
      path,
      value,
      ruleId,
      generation,
      documents,
      findings,
    );
  }
  async close(): Promise<void> {
    this.invalidate();
    await this.capabilities.close();
  }
  complete(
    params: CompletionParams,
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
    rulesOnly = false,
  ): CompletionList {
    return complete(this.state, this.history, params, generation, documents, rulesOnly);
  }
  acceptsReference(
    params: CompletionParams,
    value: string,
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
  ): boolean {
    return acceptsReference(this.state, params, value, generation, documents);
  }
  hover(
    uri: string,
    position: Position,
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
  ): Hover | null {
    return hover(this.state, uri, position, generation, documents);
  }
  definition(
    uri: string,
    position: Position,
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
  ): Location[] {
    return definition(this.state, uri, position, generation, documents);
  }
  repairs(
    findings: readonly Immutable<Finding>[],
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
  ): SuggestedFix[] {
    return repairs(this.state, findings, generation, documents);
  }
}
