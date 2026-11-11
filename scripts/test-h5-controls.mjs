import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const artifact = path.join(root, '.artifacts/vscode');
const infoPath = path.join(artifact, 'package-info.json');
const original = await readFile(infoPath, 'utf8');
const info = JSON.parse(original);
const output = path.join(
  root,
  '.artifacts/harness-remediation/H5/fault-controls',
  'run-' + Date.now(),
);
await mkdir(output, { recursive: true });
const client = 'extension/out/extension.cjs';
const server = 'extension/server/dist/lsp/';
const mutations = [
  {
    id: 'configuration-reasons-collapsed',
    cases: [
      'config-absent',
      'config-relative',
      'config-missing',
      'config-unreadable',
      'config-malformed',
      'config-structure',
      'config-server-init',
      'config-non-file',
      'config-file-limit',
      'config-byte-limit',
    ],
    expected: 'Expected sanitized startup reason',
    changes: [
      [
        'Set Backstage Validation: Config Path in User Settings to start validation.',
        'Set Backstage Validation: incorrect reason.',
      ],
      ...[
        'Select an absolute trusted configuration path in User Settings.',
        'Trusted configuration file was not found.',
        'Trusted configuration file is not readable.',
        'Trusted configuration contains invalid JSON.',
        'Invalid trusted configuration.',
        'Trusted configuration was rejected during server initialization.',
        'Only local file sources are supported.',
        'Trusted configuration exceeds the file limit.',
        'Trusted configuration exceeds the size limit.',
      ].map((text) => [text, 'Trusted configuration could not be loaded.']),
    ].map(([before, after]) => ({ file: client, before, after, all: true })),
  },
  {
    id: 'unapproved-file-admitted',
    cases: ['workspace-multi-root'],
    expected: 'AssertionError',
    changes: [
      {
        file: server + 'workspace-state.js',
        before: 'return approvedFilesystemUri(this.config, uri);',
        after: 'return true;',
      },
    ],
  },
  {
    id: 'native-watcher-ignored',
    cases: ['race-dirty-watch'],
    expected: 'ordered projection must observe an admitted watcher event',
    changes: [
      {
        file: server + 'server.js',
        before: 'connection.onDidChangeWatchedFiles((params) => {',
        after: 'connection.onDidChangeWatchedFiles((params) => { return;',
      },
    ],
  },
  {
    id: 'search-completes-before-picker',
    cases: ['editor-search'],
    expected: 'Search command must stay pending',
    changes: [
      {
        file: client,
        before: 'picker.show();\n  return completed;',
        after: 'picker.show();\n  return undefined;',
      },
    ],
  },
  {
    id: 'search-stale-insertion-allowed',
    cases: ['editor-search'],
    expected: 'AssertionError',
    changes: [{ file: client, before: 'editor.document.version === version &&', after: '' }],
  },
  {
    id: 'explicit-reload-no-op',
    cases: ['editor-intelligence'],
    expected: 'Explicit reload must send',
    changes: [
      {
        file: client,
        before: 'async function reloadConfiguration() {',
        after: 'async function reloadConfiguration() { return;',
      },
    ],
  },
  {
    id: 'crash-message-omitted',
    cases: ['server-crash'],
    expected: 'Expected user-visible stopped reason',
    changes: [
      {
        file: client,
        before:
          'Validation stopped after the server disconnected. Use Restart Language Server to recover.',
        after: 'Incorrect disconnected output.',
      },
    ],
  },
  {
    id: 'stop-message-omitted',
    cases: ['shutdown'],
    expected: 'Expected user-visible stopped reason',
    changes: [
      {
        file: client,
        before: 'Backstage validation stopped. Use Restart Language Server to resume.',
        after: 'Incorrect stopped output.',
      },
    ],
  },
  {
    id: 'surviving-finding-erased',
    cases: ['versioned-fix'],
    expected: 'unrelated owner finding must survive',
    changes: [
      {
        file: server + 'diagnostic-publisher.js',
        before: 'return this.deliver(context, diagnostics, false);',
        after:
          "return this.deliver(context, diagnostics.some(row => row.code === 'production-only') ? diagnostics : [], false);",
      },
    ],
  },
  {
    id: 'incomplete-state-not-published',
    cases: ['endurance-saturation'],
    expected: 'deterministic saturation input must execute the incomplete branch',
    changes: [
      {
        file: server + 'diagnostics.js',
        before: "code: 'validation/incomplete',",
        after: "code: 'validation/incorrectly-complete',",
      },
    ],
  },
  {
    id: 'stale-repair-admitted',
    cases: ['endurance-saturation', 'editor-credentials'],
    expected: 'AssertionError',
    changes: [
      {
        file: server + 'server.js',
        before: 'connection.onExecuteCommand((params, token) => {',
        after: 'connection.onExecuteCommand((params, token) => { return { applied: true };',
      },
    ],
  },
  {
    id: 'hover-constraint-removed',
    cases: ['editor-intelligence'],
    expected: 'Installed hover must contain its actual constraint',
    changes: [
      {
        file: 'extension/server/dist/capabilities/schema-metadata.js',
        before: 'Required value: ${JSON.stringify(node.const)}.',
        after: 'Constraint omitted.',
      },
    ],
  },
  {
    id: 'ambiguous-definition-picked',
    cases: ['editor-intelligence'],
    expected: 'Two same-reference local entities',
    changes: [
      {
        file: server + 'editor.js',
        before: 'return locations.length === 1 ? locations : [];',
        after: 'return locations.slice(0, 1);',
      },
    ],
  },
  {
    id: 'discovery-exclusions-ignored',
    cases: ['editor-discovery'],
    expected: 'AssertionError',
    changes: [
      {
        file: server + 'discovery.js',
        before: '...(settings.exclude ?? [])',
        after: '',
        all: true,
      },
    ],
  },
  {
    id: 'history-restore-omitted',
    cases: ['editor-search'],
    expected: 'Fresh activation must restore actual installed completion history ranking',
    changes: [
      {
        file: client,
        before: 'await next.sendNotification("bve/recordSelection", value);',
        after: 'void value;',
        all: true,
      },
    ],
  },
  {
    id: 'dependency-severity-elevated',
    cases: ['editor-credentials'],
    expected: 'AssertionError',
    changes: [
      {
        file: server + 'diagnostics.js',
        before:
          "finding.severity === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning",
        after: 'DiagnosticSeverity.Error',
      },
    ],
  },
];
const selected = process.argv.find((arg) => arg.startsWith('--fault='))?.slice(8);
const rows = [];
const python = `import json,sys,zipfile
source,target,changes=sys.argv[1:]
changes=json.loads(changes)
with zipfile.ZipFile(source) as old,zipfile.ZipFile(target,'w') as new:
 for entry in old.infolist():
  data=old.read(entry.filename)
  for change in changes:
   if change['file']!=entry.filename:continue
   text=data.decode('utf-8');count=text.count(change['before'])
   assert count>0 and (change.get('all') or count==1),(change['file'],change['before'],count)
   text=text.replace(change['before'],change['after'],-1 if change.get('all') else 1)
   data=text.encode('utf-8');change['matched']=True
  new.writestr(entry,data)
assert all(c.get('matched') for c in changes),changes
`;
try {
  for (const fault of mutations.filter((row) => !selected || row.id === selected)) {
    const directory = path.join(output, fault.id);
    await mkdir(directory, { recursive: true });
    const vsix = path.join(directory, 'faulty.vsix');
    const patched = spawnSync(
      'python3',
      ['-c', python, info.vsix, vsix, JSON.stringify(fault.changes)],
      { encoding: 'utf8' },
    );
    assert.equal(patched.status, 0, patched.stderr);
    await writeFile(infoPath, JSON.stringify({ ...info, vsix }));
    const env = { ...process.env, BVE_VSCODE_VERSIONS: '1.145.2' };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(
      process.execPath,
      ['scripts/test-extension.mjs', '--case=' + fault.cases.join(',')],
      { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    await writeFile(path.join(directory, 'run.log'), result.stdout + result.stderr);
    await cp(path.join(artifact, 'editor-focused'), path.join(directory, 'installed'), {
      recursive: true,
    });
    const report = JSON.parse(
      await readFile(path.join(directory, 'installed/results.json'), 'utf8'),
    );
    const failures = await Promise.all(
      fault.cases.map(async (id) => {
        const progress = JSON.parse(
          await readFile(path.join(directory, 'installed/1.145.2', id, 'progress.json'), 'utf8'),
        );
        const intended =
          progress.status === 'failed' &&
          progress.error?.includes(fault.expected) &&
          !/Timed out|session bound|launch error/iu.test(progress.error);
        return { id, intended, phase: progress.phase, error: progress.error };
      }),
    );
    const row = {
      id: fault.id,
      originalSha256: createHash('sha256')
        .update(await readFile(info.vsix))
        .digest('hex'),
      faultySha256: createHash('sha256')
        .update(await readFile(vsix))
        .digest('hex'),
      changes: fault.changes,
      exitStatus: result.status,
      counts: report.counts,
      failures,
    };
    rows.push(row);
    await writeFile(path.join(output, 'report.json'), JSON.stringify(rows, null, 2) + '\n');
    assert.notEqual(result.status, 0, fault.id + ' must reject the faulty installed candidate');
    assert(
      failures.every((row) => row.intended),
      fault.id + ' must fail its intended assertion',
    );
    console.log(fault.id + ': intended installed assertion rejected');
  }
  assert(rows.length > 0, 'Select an existing fault.');
} finally {
  await writeFile(infoPath, original);
}
