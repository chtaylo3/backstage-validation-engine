import { digestJson } from '../../src/base/json.js';
import type { EditorArtifact } from '../../src/capabilities/editor-artifacts.js';
import type { policyRun } from './policy-fixture.js';

export function editorArtifact(
  run: ReturnType<typeof policyRun>,
  overrides: Partial<EditorArtifact['contributions'][number]> = {},
) {
  const selected = run.context.policy.rules.find((row) => row.kind !== 'catalog')!;
  const value = {
    artifactVersion: 'bve-editor/1' as const,
    id: 'approved-editor',
    policyDigest: run.request.policy.digest,
    profileDigest: run.request.profile.digest,
    contributions: [
      {
        ruleId: selected.id,
        ruleDigest: digestJson(selected),
        languageProfile:
          selected.kind === 'cel'
            ? ('bve-cel/1' as const)
            : ('draft-07/re2js@2.9.0/schema-v1' as const),
        subjectStage: 'normalized' as const,
        kind: 'Component',
        apiVersion: 'backstage.io/v1alpha1',
        path: '/spec/lifecycle',
        description: 'Approved lifecycle choices. <script> stays plain text.',
        choices: ['production', 'internal', 'xproductionx'],
        repairs: true,
        ...overrides,
      },
    ],
  };
  return { ...value, digest: digestJson(value) };
}
