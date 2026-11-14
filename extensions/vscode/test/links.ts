import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { until } from './readiness.js';

/** The identifier of the driver extension that every installed-editor case runs beside. */
export const DRIVER_EXTENSION_ID = 'local.bve-test-driver';

/** How the host calls the editor's CLI. The defaults are the harness's (see `openUrlArgs`). */
export interface OpenUrlOptions {
  noSandbox?: boolean;
  verbose?: boolean;
  separator?: boolean;
}

/** What the host reports for one link: the outcome and the CLI's evidence. */
export interface OpenUrlAnswer {
  id: string;
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
 * does when a browser follows the link. Resolves with the host's answer when its CLI call has
 * finished; delivery to a URI handler is the caller's observation.
 */
export async function openUrl(url: string, options: OpenUrlOptions = {}): Promise<OpenUrlAnswer> {
  const directory = process.env.BVE_EXTENSION_TEST_CONTROL_DIRECTORY;
  assert(directory, 'The host must provide a control directory.');
  const id = randomUUID();
  await writeFile(
    path.join(directory, 'open-url-request.json'),
    JSON.stringify({ id, url, options }),
  );
  let answer: OpenUrlAnswer | undefined;
  await until(async () => {
    answer = await readFile(path.join(directory, 'open-url-ack.json'), 'utf8')
      .then((text) => JSON.parse(text) as OpenUrlAnswer)
      .catch(() => undefined);
    return answer?.id === id;
  }, 'the host gives the link to the editor');
  return answer!;
}
