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
