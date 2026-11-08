import { execFile } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function readable(file, allow) {
  if (process.platform === 'win32') {
    const { stdout } = await exec('whoami');
    const user = stdout.trim();
    await exec('icacls', allow ? [file, '/remove:d', user] : [file, '/deny', `${user}:(R)`]);
  } else await chmod(file, allow ? 0o600 : 0o000);
}
