import assert from 'node:assert/strict';
import { OBSERVATION_TIMEOUT_MS } from './readiness.js';

/** The identifier of the driver extension that every installed-editor case runs beside. */
export const DRIVER_EXTENSION_ID = 'local.bve-test-driver';

/** How the host calls the editor's CLI. The defaults are the harness's (see `openUrlArgs`). */
export interface OpenUrlOptions {
  noSandbox?: boolean;
  verbose?: boolean;
  separator?: boolean;
}

/** What the host reports for one link: the outcome and the CLI's redacted evidence. */
export interface OpenUrlAnswer {
  status: 'passed' | 'failed';
  error?: string;
  cli?: {
    args: string[];
    exitCode: number | null;
    durationMs: number;
    stdout: string;
    stderr: string;
    reason?: string | null;
    logSessionsBefore?: number;
    logSessionsAfter?: number;
  };
}

/**
 * Ask the host to give this editor a `vscode://` link with `--open-url`, as an operating system
 * does when a browser follows the link. The link goes to the host over loopback HTTP, with the
 * session's bearer token; the harness writes it to no file (it is still in the CLI's process
 * arguments while the call runs). Resolves with the host's answer when its CLI call has finished;
 * delivery to a URI handler is the caller's observation.
 */
export async function openUrl(url: string, options: OpenUrlOptions = {}): Promise<OpenUrlAnswer> {
  const endpoint = process.env.BVE_EXTENSION_TEST_LINKS;
  const token = process.env.BVE_EXTENSION_TEST_LINKS_TOKEN;
  assert(endpoint && token, 'The host must serve link requests.');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url, options }),
    signal: AbortSignal.timeout(OBSERVATION_TIMEOUT_MS),
  });
  assert.equal(response.status, 200, 'The host answers the link request.');
  return (await response.json()) as OpenUrlAnswer;
}
