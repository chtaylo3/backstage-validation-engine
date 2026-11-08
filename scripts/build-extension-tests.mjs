import { readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export async function buildExtensionTests(root = fileURLToPath(new URL('../', import.meta.url))) {
  const testDirectory = path.join(root, '.artifacts/vscode/test');
  const caseDirectory = path.join(root, 'extensions/vscode/test/cases');
  const caseFiles = (await readdir(caseDirectory))
    .filter((name) => name.endsWith('.case.ts'))
    .sort();
  if (!caseFiles.length) throw new Error('No installed-extension cases found.');
  await rm(testDirectory, { recursive: true, force: true });
  await build({
    entryPoints: [
      path.join(root, 'extensions/vscode/test/suite.ts'),
      ...caseFiles.map((name) => path.join(caseDirectory, name)),
    ],
    outdir: testDirectory,
    outbase: path.join(root, 'extensions/vscode/test'),
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
    sourcemap: true,
  });
  await build({
    entryPoints: [path.join(root, 'scripts/extension-remote-fixture.mjs')],
    outfile: path.join(testDirectory, 'remote-prepare.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    target: 'node24',
  });
  await build({
    entryPoints: [path.join(root, 'extensions/vscode/test/evidence.ts')],
    outfile: path.join(testDirectory, 'evidence.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  });
  await build({
    entryPoints: [path.join(root, 'extensions/vscode/test/qualification.ts')],
    outfile: path.join(testDirectory, 'qualification.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  });
  await build({
    entryPoints: [path.join(root, 'extensions/vscode/test/remote-catalog.ts')],
    outfile: path.join(testDirectory, 'remote-catalog.cjs'),
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'cjs',
    target: 'node24',
  });
  await build({
    entryPoints: [path.join(root, 'extensions/vscode/test/reporting.ts')],
    outfile: path.join(testDirectory, 'reporting.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  });
  await build({
    entryPoints: [path.join(root, 'extensions/vscode/test/catalog-fixture.ts')],
    outfile: path.join(testDirectory, 'catalog-fixture.cjs'),
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
  });
  await writeFile(
    path.join(testDirectory, 'inventory.json'),
    JSON.stringify(
      caseFiles.map((name) => name.replace(/\.ts$/u, '.cjs')),
      null,
      2,
    ) + '\n',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildExtensionTests();
