// Run explicitly. Normal project tests never start Docker or download an editor.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './lib/process.mjs';

const integration = fileURLToPath(new URL('./', import.meta.url));
const root = path.resolve(integration, '../../..');
const project = 'bve-uid1001-' + randomBytes(6).toString('hex');
const temporary = await mkdtemp(path.join(tmpdir(), project + '-'));
const reports = path.join(temporary, 'reports');
await mkdir(reports);
const cli = JSON.parse(await readFile(path.join(root, '.artifacts/cli/package-info.json'), 'utf8'));
const candidate = path.join(temporary, 'unused.vsix');
await writeFile(candidate, 'This permission probe does not install a VSIX.');
const env = {
  ...process.env,
  BVE_RUN_ID: project,
  BVE_OWNER: 'uid1001-regression',
  BVE_TARGET: '1.55.3',
  BVE_REVISION: 'permission-probe',
  BVE_BACKSTAGE_IMAGE: 'bve-backstage:1.55.3',
  BVE_TEST_IMAGE: 'bve-backstage-test:local',
  BVE_BACKSTAGE_PUBLIC_URL: 'http://127.0.0.1:7007',
  BVE_BACKSTAGE_PORT: '0',
  BVE_BACKSTAGE_READER_TOKEN: 'unused-permission-probe-reader',
  BVE_BACKSTAGE_ADMIN_TOKEN: 'unused-permission-probe-admin',
  BVE_BACKSTAGE_DENIED_TOKEN: 'unused-permission-probe-denied',
  BVE_REPORT_DIRECTORY: reports,
  BVE_CLI_ARCHIVE: cli.archive,
  BVE_VSIX_ARCHIVE: candidate,
  BVE_SEED_FILE: path.join(integration, 'data/baseline.json'),
};
const docker = (args) => runCommand('docker', args, { cwd: root, env, timeout: 600_000 });
const compose = (args) =>
  docker([
    'compose',
    '--project-name',
    project,
    '--file',
    path.join(integration, 'compose.yaml'),
    ...args,
  ]);
const node = (service, user, code) =>
  compose([
    'run',
    '--rm',
    '--no-deps',
    '--user',
    user,
    '--entrypoint',
    'node',
    service,
    '--input-type=module',
    '-e',
    code,
  ]);
let primaryError;
try {
  await node(
    'test',
    '0:0',
    `
    import {chown} from 'node:fs/promises';
    import {initializeRuntime} from '/workspace/test/integration/backstage/lib/runtime.mjs';
    await initializeRuntime(1001,1001);
    await chown('/reports',1001,1001);
  `,
  );
  // Mount the still-empty catalog in the actual application image before rendering.
  // Without nocopy, this mount silently restores the image's UID1000 ownership.
  await node(
    'backstage',
    '1000:1000',
    `
    import assert from 'node:assert/strict';
    import {stat,readdir} from 'node:fs/promises';
    assert.equal((await stat('/catalog')).uid,1001);
    assert.deepEqual(await readdir('/catalog'),[]);
  `,
  );
  await compose(['run', '--rm', '--no-deps', '--user', '1001:1001', 'test', 'render']);
  const result = await node(
    'test',
    '1001:1001',
    `
    import assert from 'node:assert/strict';
    import {mkdir,readFile,stat,writeFile} from 'node:fs/promises';
    import {downloadAndUnzipVSCode} from '/workspace/node_modules/@vscode/test-electron/out/index.js';
    import {installClient} from '/workspace/test/integration/backstage/lib/clients.mjs';
    import {renderSeed} from '/workspace/test/integration/backstage/lib/seed.mjs';
    const baseline=JSON.parse(await readFile('/workspace/test/integration/backstage/data/baseline.json','utf8'));
    const mutation=JSON.parse(await readFile('/workspace/test/integration/backstage/data/mutation.json','utf8'));
    assert.equal(process.getuid(),1001);
    for(const directory of ['/catalog','/run/work','/run/work/home','/run/work/npm-cache','/run/work/editor/downloads']) {
      assert.equal((await stat(directory)).uid,1001,directory);
    }
    await writeFile('/run/work/home/probe','home is writable');
    await mkdir('/run/work/editor/downloads/nested',{recursive:true});
    await writeFile('/run/work/editor/downloads/nested/probe','nested cache is writable');
    await installClient();
    const executable=await downloadAndUnzipVSCode({version:'1.106.3',platform:'linux-x64',cachePath:'/run/work/editor/downloads'});
    assert.equal((await stat(executable)).uid,1001);
    const original=await readFile('/catalog/entities.yaml','utf8');
    await renderSeed(mutation,'/catalog');
    assert.notEqual(await readFile('/catalog/entities.yaml','utf8'),original);
    await renderSeed(baseline,'/catalog');
    assert.equal(await readFile('/catalog/entities.yaml','utf8'),original);
    assert.equal((await stat('/catalog/entities.yaml')).mode&0o777,0o644);
    console.log(JSON.stringify({uid:process.getuid(),driverRender:'passed',home:'passed',npmInstall:'passed',editorDownload:'passed',mutation:'passed',restore:'passed'}));
  `,
  );
  await node(
    'backstage',
    '1000:1000',
    `
    import assert from 'node:assert/strict';
    import {readFile,writeFile} from 'node:fs/promises';
    for(const name of ['entities.yaml','child.yaml']) assert((await readFile('/catalog/'+name,'utf8')).length>0);
    await assert.rejects(writeFile('/catalog/forbidden','x'),{code:'EROFS'});
    console.log('Actual application UID1000 can read all authored files through its read-only mount.');
  `,
  );
  console.log(result.stdout.trim());
} catch (error) {
  primaryError = error;
} finally {
  try {
    await node(
      'test',
      '0:0',
      `
      import {chown,rm,readdir} from 'node:fs/promises';
      for(const name of await readdir('/reports')) await rm('/reports/'+name,{recursive:true,force:true});
      await chown('/reports',${process.getuid()},${process.getgid()});
    `,
    );
    await compose(['down', '--volumes', '--remove-orphans', '--timeout', '5']);
    for (const resource of ['container', 'volume', 'network']) {
      const listing = await docker([
        resource,
        'ls',
        '--quiet',
        '--filter',
        'label=io.bve.integration.run=' + project,
      ]);
      assert.equal(listing.stdout.trim(), '', 'Remove only the probe resources.');
    }
    await rm(temporary, { recursive: true, force: true });
  } catch (cleanupError) {
    primaryError = primaryError
      ? new AggregateError([primaryError, cleanupError], 'Permission probe and cleanup failed.', {
          cause: cleanupError,
        })
      : cleanupError;
  }
}
if (primaryError) throw primaryError;
