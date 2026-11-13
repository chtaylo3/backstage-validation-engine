import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const kernel = `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class HarnessThreads {
 [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenThread(uint access, bool inherit, uint id);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern uint SuspendThread(IntPtr handle);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern uint ResumeThread(IntPtr handle);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
}
'@
`;
/**
 * Bounds one helper run: a cold Windows PowerShell start plus the C# compilation of `kernel`. It
 * is not a product budget. The case that uses this helper starts its measurement after the helper
 * returns.
 */
const POWERSHELL_TIMEOUT_MS = 30_000;
/** Says whether the helper ran out of time or failed, without repeating the encoded script. */
export function powershellFailure(error: unknown, timeoutMs = POWERSHELL_TIMEOUT_MS): Error {
  const failure = (error ?? {}) as { killed?: boolean; code?: unknown; stderr?: unknown };
  const detail = typeof failure.stderr === 'string' ? failure.stderr.trim().slice(0, 2000) : '';
  return new Error(
    failure.killed
      ? `PowerShell helper was stopped after ${timeoutMs} ms without finishing.`
      : `PowerShell helper failed with exit code ${String(failure.code)}${detail ? ': ' + detail : '.'}`,
    { cause: error },
  );
}
async function powershell(script: string): Promise<string> {
  try {
    const { stdout } = await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from('$ErrorActionPreference="Stop"\n' + kernel + script, 'utf16le').toString(
          'base64',
        ),
      ],
      { windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS },
    );
    return stdout.trim();
  } catch (error) {
    throw powershellFailure(error);
  }
}
/** Freeze only the owned server, never the editor or an unrelated process. */
export async function suspendServer(pid: number): Promise<() => Promise<void>> {
  assert(Number.isSafeInteger(pid) && pid > 1);
  if (process.platform === 'win32') {
    const result = await powershell(`
$done = [System.Collections.Generic.List[int]]::new()
try {
 foreach ($thread in ((Get-Process -Id ${pid}).Threads | Sort-Object StartTime)) {
  $handle = [HarnessThreads]::OpenThread(2, $false, $thread.Id)
  if ($handle -eq [IntPtr]::Zero) { throw "OpenThread failed" }
  try { if ([HarnessThreads]::SuspendThread($handle) -eq [uint32]::MaxValue) { throw "SuspendThread failed" }; $done.Add($thread.Id) }
  finally { [void][HarnessThreads]::CloseHandle($handle) }
 }
 if ($done.Count -eq 0) { throw "No owned threads suspended" }
 ConvertTo-Json -InputObject @($done.ToArray()) -Compress
} catch {
 foreach ($id in $done) { $handle=[HarnessThreads]::OpenThread(2,$false,$id); if ($handle -ne [IntPtr]::Zero) { [void][HarnessThreads]::ResumeThread($handle); [void][HarnessThreads]::CloseHandle($handle) } }
 throw
}`);
    const ids = JSON.parse(result) as number[];
    assert(Array.isArray(ids) && ids.length && ids.every(Number.isSafeInteger));
    return async () => {
      await powershell(
        `foreach ($id in @(${ids.join(',')})) { $handle=[HarnessThreads]::OpenThread(2,$false,$id); if ($handle -eq [IntPtr]::Zero) { throw "OpenThread resume failed" }; try { if ([HarnessThreads]::ResumeThread($handle) -eq [uint32]::MaxValue) { throw "ResumeThread failed" } } finally { [void][HarnessThreads]::CloseHandle($handle) } }`,
      );
    };
  }
  process.kill(pid, 'SIGSTOP');
  try {
    const end = Date.now() + 5000;
    while (!(await exec('ps', ['-o', 'state=', '-p', String(pid)])).stdout.includes('T')) {
      if (Date.now() >= end) throw new Error('Owned server did not enter stopped state.');
      await pause(10);
    }
  } catch (error) {
    process.kill(pid, 'SIGCONT');
    throw error;
  }
  return () => {
    process.kill(pid, 'SIGCONT');
    return Promise.resolve();
  };
}
