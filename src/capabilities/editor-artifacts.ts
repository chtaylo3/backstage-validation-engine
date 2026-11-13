import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Ajv } from 'ajv';
import type { DeploymentProfile, PolicyBundle } from '../contracts/schemas.js';
import { digestJson, immutableJson } from '../base/json.js';
import type { Immutable } from '../base/json.js';

const text = (maximum: number) => Type.String({ minLength: 1, maxLength: maximum });
const digest = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const scalar = Type.Union([
  Type.Null(),
  Type.Boolean(),
  Type.Number(),
  Type.String({ maxLength: 4096 }),
]);
/** Launcher approval is independent from the frozen policy wire contract. */
export const EditorArtifactSchema = Type.Object(
  {
    artifactVersion: Type.Literal('bve-editor/1'),
    id: text(128),
    digest,
    policyDigest: digest,
    profileDigest: digest,
    contributions: Type.Array(
      Type.Object(
        {
          ruleId: text(128),
          ruleDigest: digest,
          languageProfile: Type.Union([
            Type.Literal('bve-cel/1'),
            Type.Literal('draft-07/re2js@2.9.0/schema-v1'),
          ]),
          subjectStage: Type.Literal('normalized'),
          kind: text(63),
          apiVersion: text(128),
          path: Type.String({ pattern: '^(?:/(?:[^~/]|~[01])+)+$', maxLength: 512 }),
          description: text(2048),
          choices: Type.Optional(Type.Array(scalar, { maxItems: 16, uniqueItems: true })),
          examples: Type.Optional(Type.Array(scalar, { maxItems: 16, uniqueItems: true })),
          defaultValue: Type.Optional(scalar),
          repairs: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 32 },
    ),
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'urn:backstage-validation:editor-artifact:bve-editor/1',
    additionalProperties: false,
  },
);
export type EditorArtifact = Static<typeof EditorArtifactSchema>;
const validate = new Ajv({ strict: true, ownProperties: true }).compile<EditorArtifact>(
  EditorArtifactSchema,
);

/** The digest covers all declarations, including the exact policy and profile. */
export function parseEditorArtifacts(
  input: readonly unknown[],
  policy: Immutable<PolicyBundle>,
  profile: Immutable<DeploymentProfile>,
): readonly Immutable<EditorArtifact>[] {
  const admitted: unknown = immutableJson(input);
  if (!Array.isArray(admitted) || admitted.length > 16)
    throw new Error('Editor artifact count exceeds limits.');
  const ids = new Set<string>();
  return admitted.map((value: unknown) => {
    const safe = immutableJson(value);
    if (!validate(safe)) throw new Error('Invalid approved editor artifact.');
    const { digest: declared, ...contents } = safe;
    if (
      digestJson(contents) !== declared ||
      safe.policyDigest !== digestJson(policy) ||
      safe.profileDigest !== digestJson(profile) ||
      ids.has(safe.id)
    )
      throw new Error('Editor artifact approval does not match its contents.');
    ids.add(safe.id);
    const bindings = new Set<string>();
    for (const row of safe.contributions) {
      const rule = policy.rules.find((rule) => rule.id === row.ruleId);
      const binding = JSON.stringify([row.ruleId, row.kind, row.apiVersion, row.path]);
      if (
        !rule ||
        rule.kind === 'catalog' ||
        digestJson(rule) !== row.ruleDigest ||
        (rule.kind === 'cel'
          ? row.languageProfile !== 'bve-cel/1'
          : row.languageProfile !== 'draft-07/re2js@2.9.0/schema-v1') ||
        bindings.has(binding) ||
        row.path.split('/').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))
      )
        throw new Error('Editor contribution does not match an approved rule.');
      bindings.add(binding);
    }
    return safe;
  });
}
