import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export interface ResourceSample {
  elapsedMs: number;
  operation: number;
  client: { rssMiB: number; handles: number };
  server: { rssMiB: number; handles: number };
  pid: number;
}
export interface GrowthBudgets {
  warmupOperations: number;
  clientGrowthMiB: number;
  serverGrowthMiB: number;
  handleGrowth: number;
  growthMiBPerOperation: number;
}
export function verifyResourceGrowth(
  samples: ResourceSample[],
  budgets: GrowthBudgets,
  requireMeasurement = true,
  requireSlope = false,
): void {
  for (const side of ['client', 'server'] as const) {
    let measured = 0;
    let slopes = 0;
    const generations =
      side === 'client'
        ? [samples]
        : [...new Set(samples.map((row) => row.pid))].map((pid) =>
            samples.filter((row) => row.pid === pid),
          );
    for (const generation of generations) {
      const origin = generation[0]?.operation;
      if (origin === undefined) continue;
      const warmed = generation.filter((row) => row.operation - origin >= budgets.warmupOperations);
      const warm = warmed.slice(Math.floor(warmed.length / 4));
      if (warm.length < 3) continue;
      measured++;
      const first = warm[0]!,
        last = warm.at(-1)!;
      const growth = last[side].rssMiB - first[side].rssMiB;
      const limit = budgets[side === 'client' ? 'clientGrowthMiB' : 'serverGrowthMiB'];
      assert(
        growth <= limit,
        `${side} retained RSS growth ${growth} MiB exceeds ${limit} after warmup`,
      );
      assert(
        last[side].handles - first[side].handles <= budgets.handleGrowth,
        side + ' handle growth',
      );
      if (last.operation - first.operation >= 100) {
        slopes++;
        const meanX = warm.reduce((sum, row) => sum + row.operation, 0) / warm.length;
        const meanY = warm.reduce((sum, row) => sum + row[side].rssMiB, 0) / warm.length;
        const slope =
          warm.reduce((sum, row) => sum + (row.operation - meanX) * (row[side].rssMiB - meanY), 0) /
          warm.reduce((sum, row) => sum + (row.operation - meanX) ** 2, 0);
        assert(slope <= budgets.growthMiBPerOperation, side + ' growth per operation');
      }
    }
    if (requireSlope)
      assert(slopes > 0, side + ' needs a measured slope spanning at least 100 operations');
    if (requireMeasurement)
      assert(measured > 0, side + ' needs enough samples after warmup in a live generation');
  }
}
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
