import { readFile, writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { digestJson } from '../../../src/base/json.js';
import assert from 'node:assert/strict';
import { until } from './readiness.js';
import type { Fixture } from './fixture.js';
import type { LspConfig } from '../../../src/lsp/config.js';
export async function configuration(): Promise<LspConfig> {
  return JSON.parse(await readFile(process.env.BVE_EXTENSION_TEST_CONFIG!, 'utf8')) as LspConfig;
}
export async function reload(value: LspConfig, fixture?: Fixture): Promise<void> {
  const offset = fixture ? (await fixture.trace()).length : 0;
  await writeFile(process.env.BVE_EXTENSION_TEST_CONFIG!, JSON.stringify(value));
  await vscode.commands.executeCommand('backstageValidation.reloadConfiguration');
  if (fixture) {
    // A separate ordered read completes even when the explicit reload bridge is
    // deliberately replaced with a no-op. Missing reload then fails an assertion.
    await fixture.api!.filesystemObservation();
    await until(
      async () =>
        (await fixture.trace())
          .slice(offset)
          .includes("Received response 'bve/filesystemObservation"),
      'post-command server read response reaches the trace',
    );
    const trace = (await fixture.trace()).slice(offset);
    const request = /Sending request 'bve\/reloadConfiguration - \((\d+)\)'/u.exec(trace);
    assert(request, 'Explicit reload must send bve/reloadConfiguration.');
    const response = trace.indexOf(
      "Received response 'bve/reloadConfiguration - (" + request[1] + ")'",
    );
    assert(response >= 0, 'Explicit reload must receive its correlated response.');
    const block = trace.slice(response).split(/\n\d{4}-\d{2}-\d{2}[^\n]*\[trace\]/u)[0]!;
    assert(
      block.includes('"reloaded": true'),
      'The correlated reload response must report reloaded:true.',
    );
    assert(fixture.api!.status().running);
    fixture.note(
      'explicit command crossed bve/reloadConfiguration boundary and received reloaded:true',
    );
  }
}

export function lifecycleConfiguration(config: LspConfig, value: string): LspConfig {
  const artifact = {
    contractVersion: '0.2' as const,
    id: 'editor/production',
    version: '1',
    schema: {
      type: 'object',
      properties: { spec: { type: 'object', properties: { lifecycle: { const: value } } } },
    },
  };
  const schemaArtifact = { ...artifact, digest: digestJson(artifact.schema) };
  const policy = {
    ...config.policy,
    rules: config.policy.rules.map((rule) =>
      rule.id === 'production-only'
        ? {
            ...rule,
            schema: { id: artifact.id, version: artifact.version, digest: schemaArtifact.digest },
          }
        : rule,
    ),
  };
  return {
    ...config,
    policy,
    schemaArtifacts: [schemaArtifact],
    activation: { ...config.activation, policyDigest: digestJson(policy) },
  };
}
