import { spawn } from 'node:child_process';
import { cp, copyFile, mkdir, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildExtensionTests } from './build-extension-tests.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = path.join(root, '.artifacts', 'vscode', 'stage');
const target = `${process.platform}-${process.arch}`;
const nodeVersion = (await readFile(path.join(root, '.nvmrc'), 'utf8')).trim();
if (process.version !== `v${nodeVersion}`)
  throw new Error(`Package with the pinned Node ${nodeVersion} runtime.`);
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this script through npm run extension:package.');
async function run(args, cwd = root) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Packaging subprocess exited ${code}.`)),
    );
  });
}
await rm(stage, { recursive: true, force: true });
await mkdir(path.join(stage, 'runtime'), { recursive: true });
await mkdir(path.join(stage, 'out'), { recursive: true });
await mkdir(path.join(stage, 'server'), { recursive: true });
for (const name of ['package.json', 'README.md'])
  await copyFile(path.join(root, 'extensions', 'vscode', name), path.join(stage, name));
await copyFile(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
await writeFile(
  path.join(stage, '.vscodeignore'),
  '**/.DS_Store\nserver/node_modules/.bin/**\nserver/node_modules/.package-lock.json\n',
);
const clientBundle = await build({
  entryPoints: [path.join(root, 'extensions/vscode/src/extension.ts')],
  outfile: path.join(stage, 'out/extension.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  sourcemap: true,
  metafile: true,
});
const clientPackages = new Map();
for (const input of Object.keys(clientBundle.metafile.inputs)) {
  let directory = path.dirname(path.resolve(root, input));
  while (directory.startsWith(path.join(root, 'node_modules') + path.sep)) {
    const metadata = await readFile(path.join(directory, 'package.json'), 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => undefined);
    if (metadata?.name && metadata.version) {
      clientPackages.set(directory, metadata);
      break;
    }
    directory = path.dirname(directory);
  }
}
const notices = [];
for (const [directory, metadata] of clientPackages) {
  const licenses = (await readdir(directory)).filter((name) =>
    /^(license|licence|copying)(\.|$)/iu.test(name),
  );
  if (!licenses.length) throw new Error(`Bundled client attribution is missing: ${metadata.name}.`);
  notices.push(
    `===== ${metadata.name}@${metadata.version} =====\n` +
      (
        await Promise.all(licenses.map((name) => readFile(path.join(directory, name), 'utf8')))
      ).join('\n'),
  );
}
await writeFile(path.join(stage, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n') + '\n');
await writeFile(
  path.join(stage, 'client-SBOM.cdx.json'),
  JSON.stringify(
    {
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      version: 1,
      components: [...clientPackages.values()].map((metadata) => ({
        type: 'library',
        name: metadata.name,
        version: metadata.version,
        purl: `pkg:npm/${metadata.name.replace('@', '%40')}@${metadata.version}`,
      })),
    },
    null,
    2,
  ) + '\n',
);
await buildExtensionTests(root);
await cp(path.join(root, 'dist'), path.join(stage, 'server/dist'), { recursive: true });
for (const name of ['package.json', 'package-lock.json', 'LICENSE'])
  await copyFile(path.join(root, name), path.join(stage, 'server', name));
await cp(path.join(root, 'schemas'), path.join(stage, 'server/schemas'), { recursive: true });
await run(
  [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
  path.join(stage, 'server'),
);
await rm(path.join(stage, 'server/node_modules/.bin'), { recursive: true, force: true });
await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [npm, 'sbom', '--sbom-format', 'cyclonedx', '--omit=dev', '--package-lock-only'],
    {
      cwd: path.join(stage, 'server'),
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    },
  );
  let text = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    text += chunk;
  });
  child.once('error', reject);
  child.once('close', async (code) => {
    try {
      if (code !== 0) throw new Error('Unable to generate packaged dependency SBOM.');
      JSON.parse(text);
      await writeFile(path.join(stage, 'server/SBOM.cdx.json'), text);
      resolve();
    } catch (error) {
      reject(error);
    }
  });
});
const executable = process.platform === 'win32' ? 'node.exe' : 'node';
await copyFile(process.execPath, path.join(stage, 'runtime', executable));
await chmod(path.join(stage, 'runtime', executable), 0o755);
let license;
for (const directory of [
  path.dirname(process.execPath),
  path.dirname(path.dirname(process.execPath)),
]) {
  license = await readFile(path.join(directory, 'LICENSE'), 'utf8').catch(() => undefined);
  if (license) break;
}
if (!license) {
  const response = await globalThis.fetch(
    `https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`,
  );
  if (!response.ok) throw new Error('Unable to obtain the pinned Node runtime license.');
  license = await response.text();
}
await writeFile(path.join(stage, 'runtime/LICENSE'), license);
const binary = await readFile(path.join(stage, 'runtime', executable));
const revision = process.env.GITHUB_SHA ?? 'local';
await writeFile(
  path.join(stage, 'build-info.json'),
  JSON.stringify(
    {
      target,
      nodeVersion,
      nodeSha256: createHash('sha256').update(binary).digest('hex'),
      revision,
    },
    null,
    2,
  ) + '\n',
);
const manifest = JSON.parse(await readFile(path.join(stage, 'package.json'), 'utf8'));
const vsix = path.join(
  root,
  '.artifacts/vscode',
  `${manifest.name}-${manifest.version}-${target}.vsix`,
);
await run(
  [
    path.join(root, 'node_modules/@vscode/vsce/vsce'),
    'package',
    '--no-dependencies',
    '--pre-release',
    '--target',
    target,
    '--out',
    vsix,
  ],
  stage,
);
const contents = await readFile(vsix);
await writeFile(
  vsix + '.sha256',
  `${createHash('sha256').update(contents).digest('hex')}  ${path.basename(vsix)}\n`,
);
await writeFile(
  path.join(root, '.artifacts/vscode/package-info.json'),
  JSON.stringify(
    { vsix, stage, target, version: manifest.version, bytes: contents.length },
    null,
    2,
  ) + '\n',
);
console.log(
  `Packaged ${path.basename(vsix)} (${contents.length} bytes), including Node ${nodeVersion}.`,
);
