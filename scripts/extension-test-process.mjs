import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout, clearTimeout, setInterval, clearInterval } from 'node:timers';

export async function readProgress(file) {
  return JSON.parse(await readFile(file, 'utf8').catch(() => 'null'));
}
export async function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    await promisify(execFile)('taskkill', ['/pid', String(pid), '/T', '/F']).catch(() => {});
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}
export async function launchEditor(
  executable,
  args,
  env,
  directory,
  crash = false,
  inspectExit,
  signal,
  windowClosed,
) {
  const log = createWriteStream(directory + '/editor-process.log');
  const child = spawn(executable, args, {
    env: { ...process.env, ...env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined },
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let failure;
  let killing;
  function terminate(message) {
    failure ??= message;
    killing ??= killTree(child.pid);
  }
  const abort = () => terminate('Editor stopped after controller failure.');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(
    () => terminate('Editor exceeded the declared session bound.'),
    env.BVE_EXTENSION_TEST_CASE === 'endurance-soak'
      ? Number(env.BVE_SOAK_SECONDS) * 1000 + 120_000
      : env.BVE_EXTENSION_TEST_CASE.startsWith('endurance-') ||
          env.BVE_EXTENSION_TEST_CASE === 'remote-session'
        ? 300_000
        : 120_000,
  );
  let polling = false;
  const poll = setInterval(() => {
    if ((!crash && !windowClosed) || polling || killing) return;
    polling = true;
    void readProgress(env.BVE_EXTENSION_TEST_PROGRESS)
      .then(async (progress) => {
        if (crash && progress?.phase === 'run')
          terminate('Injected editor crash during case execution.');
        if (windowClosed && (await windowClosed())) {
          await inspectExit();
          observedClose = true;
          child.kill('SIGTERM');
        }
      })
      .catch((error) => {
        if (windowClosed) terminate(error.stack ?? String(error));
      })
      .finally(() => {
        polling = false;
      });
  }, 20);
  let exitCode;
  let observedClose = false;
  try {
    exitCode = await new Promise((resolve) => {
      child.once('error', (error) => {
        failure = error.message;
        resolve(1);
      });
      // Remote transports can inherit the editor's pipes after its main
      // process exits. Observe native process exit, then close our pipe ends.
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    signal?.removeEventListener('abort', abort);
    clearTimeout(timer);
    clearInterval(poll);
    if (killing) await killing;
    if (!killing && !observedClose && exitCode === 0 && inspectExit) {
      try {
        await inspectExit();
      } catch (error) {
        failure = error.stack ?? String(error);
      }
    }
    // The isolated POSIX process group also owns the packaged runtime. Ensure
    // descendants of a crashed editor cannot outlive this test session.
    if (!killing && process.platform !== 'win32' && (!inspectExit || failure))
      await killTree(child.pid);
    child.stdout.destroy();
    child.stderr.destroy();
    await new Promise((resolve, reject) => {
      log.once('error', reject);
      log.end(resolve);
    });
  }
  return { exitCode: observedClose ? 0 : exitCode, ...(failure ? { error: failure } : {}) };
}
