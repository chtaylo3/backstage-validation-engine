import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import * as vscode from 'vscode';
import { until } from '../fixture.js';
import { DRIVER_EXTENSION_ID, openUrl } from '../links.js';

/**
 * The host gives this editor `vscode://` links with `--open-url`, the way an operating system does.
 * A link for the driver reaches the driver's URI handler exactly once. A link for another installed
 * extension, the product, does not reach it.
 */
export async function run(): Promise<void> {
  const driver = vscode.extensions.getExtension<{ receivedUris(): string[] }>(DRIVER_EXTENSION_ID);
  assert(driver, 'The driver extension must be present.');
  const api = await driver.activate();
  const own = randomUUID();
  const other = randomUUID();
  await openUrl(`vscode://${DRIVER_EXTENSION_ID}/open-url?probe=${own}`);
  await until(
    () => api.receivedUris().some((uri) => uri.includes(own)),
    'the link reaches the URI handler of its extension',
  );
  await openUrl(`vscode://chtaylo3.backstage-validation-engine/open-url?probe=${other}`);
  // A late or repeated delivery would arrive within this pause.
  await pause(3000);
  const received = api.receivedUris();
  assert.deepEqual(
    received.filter((uri) => uri.includes(own)),
    [`vscode://${DRIVER_EXTENSION_ID}/open-url?probe=${own}`],
    'The link reaches its handler once, unchanged.',
  );
  assert(
    !received.some((uri) => uri.includes(other)),
    'A link for another extension does not reach this handler.',
  );
}
