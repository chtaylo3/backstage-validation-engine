import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { isCanonicalSourceUri } from '../src/base/source-uris.js';

void test('native temporary directory and file URIs retain their canonical platform spelling', () => {
  const root = join(tmpdir(), 'bve-uri-probe');
  const directory = pathToFileURL(root + sep).href;
  const file = pathToFileURL(join(root, 'catalog.yaml')).href;
  assert(isCanonicalSourceUri(directory, true), JSON.stringify({ root, directory, file }));
  assert(isCanonicalSourceUri(file), JSON.stringify({ root, directory, file }));
  assert(file.startsWith(directory));
});

void test('canonical names accept Windows drive roots and ordinary escaped characters on every host', () => {
  for (const root of [
    'file:///C:/Users/runneradmin/',
    'file:///C:/Users/RUNNER%7E1/',
    'file:///D:/a/project/',
    'file:///workspace/space%20here/',
  ]) {
    assert(isCanonicalSourceUri(root, true), root);
    assert(isCanonicalSourceUri(root + 'catalog.yaml'));
  }
});
