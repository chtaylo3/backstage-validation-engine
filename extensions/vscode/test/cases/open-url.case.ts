import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import * as vscode from 'vscode';
import { DRIVER_EXTENSION_ID, openUrl } from '../links.js';

/**
 * The host gives this editor `vscode://` links with `--open-url`, the way an operating system does.
 * A link for the driver reaches the driver's URI handler exactly once. A link for another installed
 * extension, the product, does not reach it. The observation file keeps the host's CLI evidence.
 */
export async function run(): Promise<void> {
  const driver = vscode.extensions.getExtension<{ receivedUris(): string[] }>(DRIVER_EXTENSION_ID);
  assert(driver, 'The driver extension must be present.');
  const api = await driver.activate();
  const own = randomUUID();
  const other = randomUUID();
  const ownUrl = `vscode://${DRIVER_EXTENSION_ID}/open-url?probe=${own}`;
  const first = await openUrl(ownUrl);
  const end = Date.now() + 20_000;
  while (Date.now() < end && !api.receivedUris().some((uri) => uri.includes(own))) await pause(100);
  const second = await openUrl(
    `vscode://chtaylo3.backstage-validation-engine/open-url?probe=${other}`,
  );
  // A late or repeated delivery would arrive within this pause.
  await pause(3000);
  const received = api.receivedUris();
  const observation = {
    platform: process.platform,
    editorVersion: vscode.version,
    ownLink: { host: first, deliveries: received.filter((uri) => uri.includes(own)).length },
    otherLink: { host: second, deliveries: received.filter((uri) => uri.includes(other)).length },
  };
  await writeFile(
    path.join(process.env.BVE_EXTENSION_TEST_CONTROL_DIRECTORY!, 'open-url-observation.json'),
    JSON.stringify(observation, null, 2) + '\n',
  );
  const evidence = JSON.stringify(observation);
  assert.equal(first.status, 'passed', 'The host gives the first link to the editor. ' + evidence);
  // Without this, "another extension's link does not arrive" would pass if the host never sent it.
  assert.equal(
    second.status,
    'passed',
    'The host gives the second link to the editor. ' + evidence,
  );
  assert.deepEqual(
    received,
    [ownUrl],
    'The handler sees exactly one link: its own, once and unchanged, and not the other one. ' +
      evidence,
  );
}
