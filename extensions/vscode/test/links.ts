import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { until } from './readiness.js';

/** The identifier of the driver extension that every installed-editor case runs beside. */
export const DRIVER_EXTENSION_ID = 'local.bve-test-driver';

/**
 * Ask the host to give this editor a `vscode://` link with `--open-url`, as an operating system
 * does when a browser follows the link. Resolves when the host's CLI call has finished; delivery to
 * a URI handler is the caller's observation.
 */
export async function openUrl(url: string): Promise<void> {
  const directory = process.env.BVE_EXTENSION_TEST_CONTROL_DIRECTORY;
  assert(directory, 'The host must provide a control directory.');
  const id = randomUUID();
  await writeFile(path.join(directory, 'open-url-request.json'), JSON.stringify({ id, url }));
  let answer: { id?: string; status?: string; error?: string } | undefined;
  await until(async () => {
    answer = await readFile(path.join(directory, 'open-url-ack.json'), 'utf8')
      .then((text) => JSON.parse(text) as typeof answer)
      .catch(() => undefined);
    return answer?.id === id;
  }, 'the host gives the link to the editor');
  assert.equal(answer?.status, 'passed', answer?.error ?? 'The host could not open the link.');
}
