import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

interface CliError extends Error {
  reason: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
const { runCli, resolveVSCodeCli } = (await import(
  pathToFileURL(path.resolve('scripts/extension-test-cli.mjs')).href
)) as {
  runCli: (
    executable: string,
    script: string,
    args: string[],
    options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  resolveVSCodeCli: (
    executable: string,
    platform?: string,
  ) => Promise<{ cli: string; product: { commit: string } }>;
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bve CLI & %BVE_CLI_LITERAL% ^ (é) '));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const script = path.join(directory, 'cli script.cjs');
  await writeFile(
    script,
    `const {spawn}=require('node:child_process');
const mode=process.argv[2];
if(mode==='args') console.log(JSON.stringify({args:process.argv.slice(3),runAsNode:process.env.ELECTRON_RUN_AS_NODE,dev:process.env.VSCODE_DEV??null,ipc:process.env.VSCODE_IPC_HOOK_CLI,literal:process.env.BVE_CLI_LITERAL}));
if(mode==='fail'){console.log('output é');console.error('failure 🚀');process.exitCode=23;}
if(mode==='hang') {const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);}
if(mode==='output'){require('node:fs').writeFileSync(process.argv[3],String(process.pid));setInterval(()=>process.stdout.write('x'.repeat(1024)),5);}
`,
  );
  return { directory, script };
}
const failure = (reason: string, inspect?: (error: CliError) => void) => (error: unknown) => {
  assert(error instanceof Error);
  assert.equal(error.name, 'VSCodeCliError');
  const row = error as CliError;
  assert.equal(row.reason, reason);
  inspect?.(row);
  return true;
};
async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
      if (!status || /^State:\s+Z/mu.test(status)) return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
async function gone(pid: number) {
  const until = Date.now() + 3000;
  while ((await alive(pid)) && Date.now() < until) await pause(20);
  assert.equal(await alive(pid), false, `Owned CLI process ${pid} must stop.`);
}

void test('CLI preserves literal arguments and prepares the native Node environment', async (t) => {
  const { script } = await fixture(t);
  const args = [
    '',
    'two words',
    'a&echo SHOULD_NOT_RUN',
    '%BVE_CLI_LITERAL%',
    '!value!',
    '^caret',
    '(value)',
    '"quoted"',
    'é 🚀',
    'line\nbreak',
  ];
  const result = await runCli(process.execPath, script, ['args', ...args], {
    env: {
      ELECTRON_RUN_AS_NODE: '0',
      VSCODE_DEV: 'bad',
      VSCODE_IPC_HOOK_CLI: 'bad',
      BVE_CLI_LITERAL: 'must-not-expand',
    },
  });
  assert.deepEqual(JSON.parse(result.stdout) as unknown, {
    args,
    runAsNode: '1',
    dev: null,
    ipc: '',
    literal: 'must-not-expand',
  });
  assert.equal(result.stderr, '');
});

void test('CLI failures preserve the exit code and complete UTF-8 stdout and stderr', async (t) => {
  const { script } = await fixture(t);
  await assert.rejects(
    runCli(process.execPath, script, ['fail']),
    failure('exit', (error) => {
      assert.equal(error.exitCode, 23);
      assert.equal(error.stdout.trim(), 'output é');
      assert.equal(error.stderr.trim(), 'failure 🚀');
    }),
  );
});

void test('CLI spawn errors fail rather than producing empty successful output', async (t) => {
  const { directory, script } = await fixture(t);
  await assert.rejects(runCli(path.join(directory, 'missing.exe'), script, []), failure('spawn'));
});

void test('CLI timeout stops the owned process and its descendant before rejecting', async (t) => {
  const { script } = await fixture(t);
  let pids: { parent: number; child: number } | undefined;
  await assert.rejects(
    runCli(process.execPath, script, ['hang'], { timeoutMs: 2000 }),
    failure('timeout', (error) => {
      pids = JSON.parse(error.stdout) as typeof pids;
    }),
  );
  assert(pids?.parent && pids.child);
  await Promise.all([gone(pids.parent), gone(pids.child)]);
});

void test('CLI output is bounded and an overflowing producer stops before rejection', async (t) => {
  const { directory, script } = await fixture(t);
  const pidFile = path.join(directory, 'producer.pid');
  await assert.rejects(
    runCli(process.execPath, script, ['output', pidFile], { maxOutputBytes: 512 }),
    failure('output_limit', (error) => {
      assert(Buffer.byteLength(error.stdout + error.stderr) <= 512);
    }),
  );
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert(Number.isInteger(pid) && pid > 0);
  await gone(pid);
});

const commit = 'a'.repeat(40);
async function layout(root: string, relative: string, value = commit) {
  const app = path.join(root, relative);
  await mkdir(path.join(app, 'out'), { recursive: true });
  await writeFile(path.join(app, 'product.json'), JSON.stringify({ commit: value }));
  await writeFile(path.join(app, 'out/cli.js'), '');
  return path.join(app, 'out/cli.js');
}
void test('CLI resolution supports native Linux, macOS and both Windows resource layouts', async (t) => {
  for (const [platform, executable, relative] of [
    ['linux', 'code', 'resources/app'],
    ['darwin', 'Code.app/Contents/MacOS/Code', 'Code.app/Contents/Resources/app'],
    ['win32', 'Code.exe', 'resources/app'],
    ['win32', 'Code.exe', commit.slice(0, 10) + '/resources/app'],
  ])
    await t.test(platform + '/' + relative, async (t) => {
      const { directory } = await fixture(t);
      const full = path.join(directory, executable!);
      await mkdir(path.dirname(full), { recursive: true });
      const cli = await layout(directory, relative!);
      assert.deepEqual(await resolveVSCodeCli(full, platform), { cli, product: { commit } });
    });
});

void test('CLI resolution rejects ambiguous resources, mismatched commits and batch launchers', async (t) => {
  const { directory } = await fixture(t);
  const executable = path.join(directory, 'Code.exe');
  await assert.rejects(resolveVSCodeCli(executable, 'win32'), /unambiguous/u);
  const first = await layout(directory, 'resources/app');
  await layout(directory, commit.slice(0, 10) + '/resources/app');
  await assert.rejects(resolveVSCodeCli(executable, 'win32'), /unambiguous/u);
  await rm(path.resolve(first, '../..'), { recursive: true });
  await writeFile(
    path.join(directory, commit.slice(0, 10), 'resources/app/product.json'),
    JSON.stringify({ commit: 'b'.repeat(40) }),
  );
  await assert.rejects(resolveVSCodeCli(executable, 'win32'), /equal/u);
  await assert.rejects(resolveVSCodeCli(path.join(directory, 'code.cmd'), 'win32'), /native/u);
  assert.throws(() => runCli(path.join(directory, 'code.cmd'), first, []), /native/u);
});
