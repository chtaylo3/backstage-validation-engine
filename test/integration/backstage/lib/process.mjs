import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function runCommand(
  command,
  args,
  { cwd, env, timeout = 300_000, signal, allowFailure = false } = {},
) {
  try {
    const result = await exec(command, args, {
      cwd,
      env,
      timeout,
      ...(signal ? { signal } : {}),
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      shell: false,
    });
    return { ...result, code: 0 };
  } catch (error) {
    if (!allowFailure || typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}
