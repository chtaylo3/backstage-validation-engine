import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { attachLspServer } from '../../src/lsp/server.js';
import { BVE_METHOD_SHAPES } from '../../src/protocol/index.js';
import { fakeConfig, fakeConnection, fakeFilesystem } from '../harness/lsp-fake-connection.js';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const shapes = Object.entries(BVE_METHOD_SHAPES);
const clientToServer = shapes.filter(([, shape]) => shape.direction === 'clientToServer');

for (const filesystem of [false, true])
  void test(`protocol parity: the server registers exactly the client-to-server protocol methods (filesystem ${filesystem})`, async () => {
    const fake = fakeConnection();
    const server = attachLspServer(
      fake.connection,
      fakeConfig({ filesystem }),
      filesystem ? { filesystem: fakeFilesystem() } : {},
    );
    for (const [method, shape] of clientToServer) {
      const rows = fake.registrations.filter((row) => row.method === method);
      assert.equal(rows.length, 1, `${method} has one handler`);
      assert.equal(rows[0]!.kind, shape.kind, `${method} is a ${shape.kind}`);
    }
    const custom = fake.registrations
      .map((row) => row.method)
      .filter((method) => method.startsWith('bve/'))
      .sort();
    assert.deepEqual(custom, clientToServer.map(([method]) => method).sort());
    await server.close();
  });

void test('protocol parity: the VS Code client spells no custom method as a string literal', async () => {
  const file = path.join(repository, 'extensions/vscode/src/extension.ts');
  const source = ts.createSourceFile(
    file,
    await readFile(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const literals: string[] = [];
  let strings = 0;
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      strings++;
      if (node.text.startsWith('bve/')) literals.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert(strings > 0, 'The client source has string literals, so the scan ran.');
  assert.deepEqual(literals, []);
});
