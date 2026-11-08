import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function resources(pid: number): Promise<{ rssMiB: number; handles: number }> {
  if (process.platform === 'linux') {
    const [status, files] = await Promise.all([
      readFile(`/proc/${pid}/status`, 'utf8'),
      readdir(`/proc/${pid}/fd`),
    ]);
    return { rssMiB: Number(/VmRSS:\s+(\d+)/u.exec(status)?.[1]) / 1024, handles: files.length };
  }
  if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p=Get-Process -Id ${pid} -ErrorAction Stop; @{rssMiB=$p.WorkingSet64/1MB;handles=$p.HandleCount} | ConvertTo-Json -Compress`,
    ]);
    return JSON.parse(stdout) as { rssMiB: number; handles: number };
  }
  const [{ stdout: rss }, { stdout: descriptors }] = await Promise.all([
    exec('ps', ['-o', 'rss=', '-p', String(pid)]),
    exec('lsof', ['-a', '-p', String(pid), '-F', 'f']),
  ]);
  return {
    rssMiB: Number(rss.trim()) / 1024,
    handles: descriptors.split('\n').filter((line) => /^f\d/u.test(line)).length,
  };
}
export async function ownedServers(extensionPath: string): Promise<number[]> {
  const runtime = extensionPath.replaceAll('\\', '/').toLowerCase() + '/runtime/node';
  if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Select-Object ProcessId,ExecutablePath) -Compress`,
    ]);
    const rows = JSON.parse(stdout || '[]') as { ProcessId: number; ExecutablePath: string }[];
    return rows
      .filter((row) => row.ExecutablePath?.replaceAll('\\', '/').toLowerCase().startsWith(runtime))
      .map((row) => row.ProcessId);
  }
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,command=']);
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return match && Number(match[2]) === process.pid && match[3]!.toLowerCase().includes(runtime)
      ? [Number(match[1])]
      : [];
  });
}
