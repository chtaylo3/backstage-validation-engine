import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout, clearTimeout, setInterval, clearInterval } from 'node:timers';

export async function readProgress(file) {
  return JSON.parse(await readFile(file, 'utf8').catch(() => 'null'));
}
async function killTree(pid) {
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
export async function launchEditor(executable, args, env, directory, crash = false, inspectExit) {
  const log = createWriteStream(directory + '/editor-process.log');
  const child = spawn(executable, args, {
    env: { ...process.env, ...env },
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
  const timer = setTimeout(
    () => terminate('Editor exceeded the 120-second session bound.'),
    120_000,
  );
  let polling = false;
  const poll = setInterval(() => {
    if (!crash || polling || killing) return;
    polling = true;
    void readProgress(env.BVE_EXTENSION_TEST_PROGRESS)
      .then((progress) => {
        if (progress?.phase === 'run') terminate('Injected editor crash during case execution.');
      })
      .catch(() => {})
      .finally(() => {
        polling = false;
      });
  }, 20);
  let exitCode;
  try {
    exitCode = await new Promise((resolve) => {
      child.once('error', (error) => {
        failure = error.message;
        resolve(1);
      });
      child.once('close', (code) => resolve(code ?? 1));
    });
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    if (killing) await killing;
    if (!killing && exitCode === 0 && inspectExit) {
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
    await new Promise((resolve, reject) => {
      log.once('error', reject);
      log.end(resolve);
    });
  }
  return { exitCode, ...(failure ? { error: failure } : {}) };
}
