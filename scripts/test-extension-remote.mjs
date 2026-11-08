import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { downloadAndUnzipVSCode, runVSCodeCommand } from '@vscode/test-electron';
import { launchEditor } from './extension-test-process.mjs';
import { debugPort, observeWorkbench } from './extension-test-ui.mjs';
import { classify, junit } from '../.artifacts/vscode/test/reporting.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv.find((value) => value.startsWith('--mode='))?.slice(7);
const payload = process.argv.includes('--prepare-wsl-payload');
assert(
  payload || ['ssh-remote', 'dev-container', 'wsl'].includes(mode),
  'Select a real remote environment.',
);
assert(
  process.platform === (mode === 'wsl' ? 'win32' : 'linux'),
  'Run WSL from a Windows desktop, and container lanes from Linux.',
);
const exec = promisify(execFile);
const run = async (file, args, options = {}) =>
  (
    await exec(file, args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 300_000,
      windowsHide: true,
      ...options,
    })
  ).stdout.trim();
const out = path.join(
  root,
  '.artifacts/vscode',
  payload ? 'remote-linux-payload' : 'remote-results/' + mode,
);
await mkdir(out, { recursive: true });
const evidence = {
  mode: mode ?? 'linux-payload',
  revision: process.env.GITHUB_SHA ?? (await run('git', ['rev-parse', 'HEAD'])),
  image: 'ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852',
  status: 'running',
  preflight: [],
  sessions: [],
  runner: { os: process.platform, arch: process.arch, image: process.env.ImageVersion ?? null },
};
const save = async () => {
  const cases = ['1.106.3', '1.145.2'].flatMap((version) =>
    [0, 1].map((stage) => {
      const row = evidence.sessions.find(
        (value) => value.version === version && value.stage === stage,
      );
      const state = row
        ? classify(
            { id: 'remote-session', version },
            { ...row.result, ...(row.progress ? { progress: row.progress } : {}) },
          )
        : { status: 'unexecuted', phase: 'launch' };
      return {
        id: stage === 0 ? 'remote-disconnect' : 'remote-reconnect',
        version,
        durationMs: row?.durationMs ?? 0,
        ...state,
      };
    }),
  );
  const counts = {
    discovered: 4,
    executed: cases.filter((row) => row.status !== 'unexecuted').length,
    passed: cases.filter((row) => row.status === 'passed').length,
    failed: cases.filter((row) => row.status === 'failed').length,
    unexecuted: cases.filter((row) => row.status === 'unexecuted').length,
  };
  if (!payload) evidence.counts = counts;
  await writeFile(path.join(out, 'results.json'), JSON.stringify(evidence, null, 2) + '\n');
  if (!payload)
    await writeFile(
      path.join(out, 'junit.xml'),
      junit({
        metadata: { revision: evidence.revision, mode, vsixSha256: evidence.vsixSha256 ?? null },
        conclusion:
          evidence.status === 'running'
            ? 'running'
            : evidence.status === 'passed'
              ? 'success'
              : 'failure',
        counts,
        cases,
      }),
    );
};
const session = await mkdtemp(path.join(tmpdir(), 'bve-remote-'));
const containerName = 'bve-' + randomUUID();
const catalogToken = randomUUID();
const remoteEnvironment = {
  ...process.env,
  BVE_EDITOR_CATALOG_TOKEN: catalogToken,
  BVE_LSP_CONFIG: '/tmp/bve-env-selection-must-not-win.json',
  WSLENV: [process.env.WSLENV, 'BVE_EDITOR_CATALOG_TOKEN/u', 'BVE_LSP_CONFIG/u']
    .filter(Boolean)
    .join(':'),
};
const distro = 'BveCI-' + randomUUID();
let container,
  imported = false;
let remote;
const desktops = [];
const hosts = [];
let remotePath = (value) => Promise.resolve(value);
async function preflight(name, work) {
  try {
    const result = await work();
    evidence.preflight.push({ name, status: 'passed', result });
    await save();
    return result;
  } catch (error) {
    evidence.preflight.push({ name, status: 'failed', error: error.stack ?? String(error) });
    await save();
    throw error;
  }
}
try {
  let info;
  if (mode === 'wsl') {
    await preflight('Windows WSL2 executable and virtualization', () =>
      run('wsl.exe', ['--status']),
    );
    const directory = path.join(root, '.artifacts/remote-linux-payload');
    info = JSON.parse(await readFile(path.join(directory, 'payload.json'), 'utf8'));
    info.vsix = path.join(directory, info.vsix);
    const rootfs = path.join(directory, 'rootfs.tar');
    assert.equal(
      createHash('sha256')
        .update(await readFile(rootfs))
        .digest('hex'),
      info.rootfsSha256,
    );
    assert.equal(
      createHash('sha256')
        .update(await readFile(info.vsix))
        .digest('hex'),
      info.vsixSha256,
    );
    await preflight('Import and boot an isolated WSL2 distribution', async () => {
      await run('wsl.exe', [
        '--import',
        distro,
        path.join(session, 'distro'),
        rootfs,
        '--version',
        '2',
      ]);
      imported = true;
      const kernel = await run('wsl.exe', ['-d', distro, '--exec', 'uname', '-r']);
      assert(/microsoft.*WSL2/iu.test(kernel), 'An actual WSL2 kernel is required.');
      return kernel;
    });
    remote = (file, args) =>
      run('wsl.exe', ['-d', distro, '--exec', file, ...args], { env: remoteEnvironment });
    remotePath = (value) => remote('wslpath', ['-a', value]);
  } else {
    info = JSON.parse(
      await readFile(path.join(root, '.artifacts/vscode/package-info.json'), 'utf8'),
    );
    assert.equal(info.target, 'linux-x64', 'Remote workspace host needs the Linux x64 VSIX.');
    await preflight('Docker daemon', () =>
      run('docker', ['version', '--format', '{{.Server.Version}}']),
    );
    await preflight('Build pinned remote workspace image', () =>
      run(
        'docker',
        [
          'build',
          '-t',
          'bve-editor-remote-fixture',
          path.join(root, 'test/fixtures/editor-remote'),
        ],
        { timeout: 600_000 },
      ),
    );
    evidence.imageId = await run('docker', [
      'image',
      'inspect',
      'bve-editor-remote-fixture',
      '--format',
      '{{.Id}}',
    ]);
    container = await run('docker', [
      'run',
      '-d',
      '--name',
      containerName,
      '--hostname',
      containerName,
      '--network',
      'host',
      '--env',
      'BVE_EDITOR_CATALOG_TOKEN=' + catalogToken,
      '--env',
      'BVE_LSP_CONFIG=/tmp/bve-env-selection-must-not-win.json',
      '--mount',
      `type=bind,source=${session},target=${session}`,
      '--mount',
      `type=bind,source=${root},target=${root},readonly`,
      'bve-editor-remote-fixture',
      'sleep',
      'infinity',
    ]);
    remote = (file, args) => run('docker', ['exec', container, file, ...args]);
    await run('docker', [
      'cp',
      path.join(info.stage, 'runtime/node'),
      container + ':/opt/bve-node',
    ]);
    if (payload) {
      const vsix = path.basename(info.vsix);
      await cp(info.vsix, path.join(out, vsix));
      await run('docker', ['export', '--output', path.join(out, 'rootfs.tar'), container], {
        timeout: 300_000,
      });
      await writeFile(
        path.join(out, 'payload.json'),
        JSON.stringify(
          {
            revision: evidence.revision,
            vsix,
            vsixSha256: createHash('sha256')
              .update(await readFile(info.vsix))
              .digest('hex'),
            rootfsSha256: createHash('sha256')
              .update(await readFile(path.join(out, 'rootfs.tar')))
              .digest('hex'),
            target: 'linux-x64',
            image: evidence.image,
            imageId: evidence.imageId,
          },
          null,
          2,
        ) + '\n',
      );
      evidence.status = 'passed';
      await save();
    }
  }
  if (!payload) {
    evidence.vsixSha256 = createHash('sha256')
      .update(await readFile(info.vsix))
      .digest('hex');
    if (mode === 'wsl')
      assert.equal(
        info.revision,
        evidence.revision,
        'Use a Linux payload from this exact candidate revision.',
      );
    const installed = path.join(session, 'local-extensions');
    const installerOptions = {
      version: '1.145.2',
      reuseMachineInstall: true,
      spawn: { env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1', VSCODE_IPC_HOOK_CLI: '' } },
    };
    const plugin = {
      'ssh-remote': 'ms-vscode-remote.remote-ssh@0.122.0',
      'dev-container': 'ms-vscode-remote.remote-containers@0.430.0',
      wsl: 'ms-vscode-remote.remote-wsl@0.104.3',
    }[mode];
    evidence.remoteExtension = plugin;
    await preflight('Install pinned remote extension', () =>
      runVSCodeCommand(
        [
          '--install-extension',
          plugin,
          '--extensions-dir',
          installed,
          '--user-data-dir',
          path.join(session, 'installer-profile'),
          '--no-sandbox',
        ],
        installerOptions,
      ).then((result) => result.stdout),
    );
    let sshConfig;
    if (mode === 'ssh-remote') {
      const key = path.join(session, 'id_ed25519');
      await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
      await remote('cp', [key + '.pub', '/root/.ssh/authorized_keys']);
      await remote('chmod', ['600', '/root/.ssh/authorized_keys']);
      // Reserve a loopback port; the container shares this ephemeral runner's network.
      const port = await debugPort();
      await remote('/usr/sbin/sshd', ['-p', String(port)]);
      sshConfig = path.join(session, 'ssh-config');
      await writeFile(
        sshConfig,
        `Host bve\n HostName 127.0.0.1\n Port ${port}\n User root\n IdentityFile ${key}\n IdentitiesOnly yes\n StrictHostKeyChecking no\n UserKnownHostsFile ${path.join(session, 'known_hosts')}\n SendEnv BVE_EDITOR_CATALOG_TOKEN BVE_LSP_CONFIG\n`,
      );
      await preflight('Authenticated ephemeral SSH workspace', () =>
        run('ssh', ['-F', sshConfig, 'bve', 'hostname']),
      );
    }
    for (const version of ['1.106.3', '1.145.2']) {
      const base = path.join(out, version);
      await mkdir(base, { recursive: true });
      const executable = await downloadAndUnzipVSCode({ version });
      const product = JSON.parse(
        await readFile(path.join(path.dirname(executable), 'resources/app/product.json'), 'utf8'),
      );
      const commit = product.commit;
      assert(/^[a-f0-9]{40}$/u.test(commit));
      const remoteSession =
        mode === 'wsl' ? '/tmp/bve-' + version + '-' + randomUUID() : path.join(session, version);
      await remote('mkdir', ['-p', remoteSession, '/root/.vscode-server/bin/' + commit]);
      await preflight('Pin workspace server ' + version, async () => {
        const archive = path.posix.join(remoteSession, 'server.tar.gz');
        await remote('curl', [
          '--fail',
          '--location',
          '--retry',
          '2',
          'https://update.code.visualstudio.com/commit:' + commit + '/server-linux-x64/stable',
          '-o',
          archive,
        ]);
        const digest = await remote('sha256sum', [archive]);
        assert(/^[a-f0-9]{64} /u.test(digest), 'Record the actual remote archive checksum.');
        await remote('tar', [
          '-xzf',
          archive,
          '--strip-components=1',
          '-C',
          '/root/.vscode-server/bin/' + commit,
        ]);
        return { version, commit, archiveSha256: digest.split(' ')[0] };
      });
      await preflight('Install Linux-target product on remote host ' + version, async () =>
        remote('/root/.vscode-server/bin/' + commit + '/bin/code-server', [
          '--install-extension',
          await remotePath(info.vsix),
          '--force',
        ]),
      );
      await remote('/opt/bve-node', [
        await remotePath(path.join(root, '.artifacts/vscode/test/remote-prepare.mjs')),
        remoteSession,
        await remotePath(path.join(root, '.artifacts/vscode/test')),
        version,
        mode,
        evidence.revision,
        await remotePath(root),
      ]);
      const fixture = JSON.parse(
        await remote('cat', [path.posix.join(remoteSession, 'fixture.json')]),
      );
      hosts.push({ remoteSession, base, version });
      // Register the autonomous driver through the real remote extension CLI;
      // copying an unregistered folder can miss the remote profile's inventory.
      const driver = path.join(session, 'driver-' + version);
      await mkdir(driver, { recursive: true });
      const manifest = JSON.parse(
        await remote('cat', [path.posix.join(fixture.driver, 'package.json')]),
      );
      Object.assign(manifest, {
        description: 'Ephemeral installed VSIX qualification driver',
        license: 'Apache-2.0',
        repository: {
          type: 'git',
          url: 'https://github.com/chtaylo3/backstage-validation-engine.git',
        },
      });
      await writeFile(path.join(driver, 'package.json'), JSON.stringify(manifest));
      await writeFile(
        path.join(driver, 'index.cjs'),
        await remote('cat', [path.posix.join(fixture.driver, 'index.cjs')]),
      );
      await writeFile(
        path.join(driver, 'README.md'),
        'Synthetic qualification driver; no production extension override.\n',
      );
      await cp(path.join(root, 'LICENSE'), path.join(driver, 'LICENSE'));
      const driverVsix = path.join(session, 'driver-' + version + '.vsix');
      await run(
        process.execPath,
        [
          path.join(root, 'node_modules/@vscode/vsce/vsce'),
          'package',
          '--no-dependencies',
          '--out',
          driverVsix,
        ],
        { cwd: driver },
      );
      await remote('/root/.vscode-server/bin/' + commit + '/bin/code-server', [
        '--install-extension',
        await remotePath(driverVsix),
        '--force',
      ]);
      if (mode !== 'wsl')
        assert.notEqual(
          fixture.hostname,
          await run(process.platform === 'win32' ? 'hostname.exe' : 'hostname', []),
          'Remote host must be distinct from the desktop host.',
        );
      const profile = path.join(session, 'profile-' + version);
      desktops.push({ profile, base });
      await mkdir(path.join(profile, 'User'), { recursive: true });
      await writeFile(
        path.join(profile, 'User/settings.json'),
        JSON.stringify({
          'backstageValidation.configPath': fixture.config,
          'telemetry.telemetryLevel': 'off',
          'extensions.autoUpdate': false,
          'extensions.ignoreRecommendations': true,
          'chat.disableAIFeatures': true,
          'workbench.startupEditor': 'none',
          'update.mode': 'none',
          'remote.SSH.configFile': sshConfig,
          'remote.SSH.useExecServer': false,
          'remote.SSH.useLocalServer': false,
          'remote.SSH.showLoginTerminal': false,
          'remote.SSH.remotePlatform': { bve: 'linux' },
        }),
      );
      const authority =
        mode === 'ssh-remote'
          ? 'ssh-remote+bve'
          : mode === 'wsl'
            ? 'wsl+' + distro
            : 'attached-container+' +
              Buffer.from(JSON.stringify({ containerName: '/' + containerName })).toString('hex');
      const args = [
        `--folder-uri=vscode-remote://${authority}${fixture.workspace}`,
        '--extensions-dir',
        installed,
        '--user-data-dir',
        profile,
        '--disable-workspace-trust',
        '--disable-gpu',
        '--no-sandbox',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-updates',
      ];
      for (let stage = 0; stage < 2; stage++) {
        await remote('rm', ['-f', path.posix.join(remoteSession, 'progress.json')]);
        const directory = path.join(base, 'session-' + stage);
        await mkdir(directory, { recursive: true });
        const started = Date.now();
        const port = await debugPort(),
          observerAbort = new globalThis.AbortController();
        let exited = false;
        const observation = observeWorkbench({
          port,
          directory,
          isExited: () => exited,
          signal: observerAbort.signal,
        });
        const result = await launchEditor(
          executable,
          [...args, '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1'],
          {
            BVE_EDITOR_CATALOG_TOKEN: catalogToken,
            BVE_LSP_CONFIG: remoteEnvironment.BVE_LSP_CONFIG,
            WSLENV: remoteEnvironment.WSLENV,
            BVE_EXTENSION_TEST_CASE: 'remote-session',
            BVE_EXTENSION_TEST_PROGRESS: path.join(directory, 'progress.json'),
            DONT_PROMPT_WSL_INSTALL: '1',
            VSCODE_IPC_HOOK_CLI: '',
          },
          directory,
          false,
          stage !== 0
            ? undefined
            : async () => {
                const marker = JSON.parse(
                  await remote('cat', [path.posix.join(remoteSession, 'close.json')]),
                );
                const progress = JSON.parse(
                  await remote('cat', [path.posix.join(remoteSession, 'progress.json')]),
                );
                assert(progress.serverPids.includes(marker.pid));
                await remote('/opt/bve-node', [
                  '-e',
                  `const end=Date.now()+20000;function check(){try{process.kill(${Number(marker.pid)},0)}catch(e){if(e.code==='ESRCH')return;throw e}if(Date.now()>end)process.exit(1);setTimeout(check,30)}check()`,
                ]);
                await writeFile(
                  path.join(directory, 'disconnect-observation.json'),
                  JSON.stringify(
                    { beforeHostCleanup: true, serverExited: true, ...marker },
                    null,
                    2,
                  ) + '\n',
                );
                progress.status = 'passed';
                progress.phase = 'complete';
                progress.parentObservedRemoteDisconnect = true;
                await remote('/opt/bve-node', [
                  '-e',
                  `require('fs').writeFileSync(${JSON.stringify(path.posix.join(remoteSession, 'progress.json'))},${JSON.stringify(JSON.stringify(progress))})`,
                ]);
              },
        ).finally(async () => {
          exited = true;
          observerAbort.abort();
          await observation;
        });
        const progress = JSON.parse(
          await remote('cat', [path.posix.join(remoteSession, 'progress.json')]).catch(
            () => 'null',
          ),
        );
        await writeFile(
          path.join(directory, 'progress.json'),
          JSON.stringify(progress, null, 2) + '\n',
        );
        evidence.sessions.push({
          version,
          commit,
          stage,
          hostname: fixture.hostname,
          result,
          progress,
          durationMs: Date.now() - started,
        });
        await save();
        assert.equal(result.exitCode, 0, result.error);
        assert(!result.error, result.error);
        assert.equal(progress?.status, 'passed', progress?.error ?? 'No completed remote case.');
        assert.equal(progress?.editorVersion, version);
      }
      await cp(path.join(profile, 'logs'), path.join(base, 'desktop-logs'), {
        recursive: true,
      }).catch(() => {});
      await remote('/opt/bve-node', [
        '-e',
        `process.kill(${Number(fixture.catalogPid)},'SIGTERM')`,
      ]);
      await remote('/opt/bve-node', [
        '-e',
        `const fs=require('fs'),end=Date.now()+20000;function check(){if(fs.existsSync(${JSON.stringify(path.posix.join(remoteSession, 'catalog-events.json'))}))return;if(Date.now()>end)process.exit(1);setTimeout(check,30)}check()`,
      ]);
      await writeFile(
        path.join(base, 'catalog-events.json'),
        await remote('cat', [path.posix.join(remoteSession, 'catalog-events.json')]),
      );
    }
    assert.equal(
      evidence.sessions.length,
      4,
      'Both versions must execute disconnect and reconnect.',
    );
    evidence.status = 'passed';
    await save();
  }
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error.stack ?? String(error);
  await save();
  throw error;
} finally {
  for (const { profile, base } of desktops)
    await cp(path.join(profile, 'logs'), path.join(base, 'desktop-logs'), {
      recursive: true,
    }).catch(() => {});
  if (remote)
    for (const { remoteSession, base } of hosts)
      for (const file of ['progress.json', 'close.json', 'catalog-events.json']) {
        const value = await remote('cat', [path.posix.join(remoteSession, file)]).catch(
          () => undefined,
        );
        if (value) await writeFile(path.join(base, 'last-host-' + file), value + '\n');
      }
  if (container)
    await run('docker', [
      'exec',
      container,
      'chown',
      '-R',
      `${process.getuid()}:${process.getgid()}`,
      session,
    ]).catch((error) => {
      evidence.cleanupError = String(error);
      process.exitCode = 1;
    });
  if (container)
    await run('docker', ['rm', '-f', container]).catch((error) => {
      evidence.cleanupError = String(error);
      process.exitCode = 1;
    });
  if (imported)
    await run('wsl.exe', ['--unregister', distro]).catch((error) => {
      evidence.cleanupError = String(error);
      process.exitCode = 1;
    });
  await rm(session, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (evidence.cleanupError) evidence.status = 'failed';
  await save();
}
