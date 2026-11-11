import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import { converge, refresh, request } from '../lib/catalog.mjs';
import { renderSeed } from '../lib/seed.mjs';

const productId = 'chtaylo3.backstage-validation-engine';
const codeOf = (diagnostic) =>
  typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;

async function until(check, description, limit = 20_000) {
  const end = performance.now() + limit;
  while (!(await check())) {
    if (performance.now() >= end) throw new Error('Timed out: ' + description);
    await delay(30);
  }
}
async function alive(pid) {
  try {
    process.kill(pid, 0);
    const state = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
    return !!state && !/^State:\s+Z/mu.test(state);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
async function save(file, value) {
  await writeFile(file + '.next', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(file + '.next', file);
}

export async function run() {
  const input = JSON.parse(await readFile(process.env.BVE_BACKSTAGE_EDITOR_INPUT, 'utf8'));
  const file = input.progressFile;
  const progress = {
    id: input.id,
    editorVersion: vscode.version,
    status: 'running',
    phase: 'setup',
    serverPids: [],
    observations: [],
    cleanup: { status: 'running' },
  };
  const note = (event, detail = {}) =>
    progress.observations.push({ event, at: Date.now(), ...detail });
  const checkpoint = () => save(file, progress);
  const uri = vscode.Uri.file(input.sourceFile);
  const readerToken = process.env.BVE_BACKSTAGE_READER_TOKEN;
  const adminToken = process.env.BVE_BACKSTAGE_ADMIN_TOKEN;
  const deniedToken = process.env.BVE_BACKSTAGE_DENIED_TOKEN;
  let api;
  let document;
  let generation = 0;
  let appStopped = false;
  let seedChanged = false;
  const snapshot = () =>
    vscode.languages.getDiagnostics(uri).filter((row) => row.source === 'backstage-validation');
  const has = (code) => snapshot().some((row) => codeOf(row) === code);
  const dependency = () => snapshot().some((row) => row.data?.category === 'dependency');
  const rememberPid = () => {
    const pid = api?.status().pid;
    assert(
      Number.isSafeInteger(pid) && pid > 1,
      'The installed server must expose its process ID.',
    );
    if (!progress.serverPids.includes(pid)) progress.serverPids.push(pid);
    return pid;
  };
  async function open() {
    await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
    await until(
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      'open the approved catalog document',
    );
    document = vscode.window.activeTextEditor.document;
    return document;
  }
  async function replace(text) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
      text,
    );
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  }
  async function currentDiagnostic(code = 'production-only') {
    await until(
      () =>
        snapshot().some((row) => codeOf(row) === code && row.data?.version === document.version),
      'current versioned ' + code,
    );
    return snapshot().find((row) => codeOf(row) === code && row.data?.version === document.version);
  }
  async function fix() {
    let command;
    await until(async () => {
      const diagnostic = snapshot().find(
        (row) => codeOf(row) === 'production-only' && row.data?.version === document.version,
      );
      if (!diagnostic) return false;
      let actions;
      try {
        actions = await vscode.commands.executeCommand(
          'vscode.executeCodeActionProvider',
          uri,
          diagnostic.range,
          vscode.CodeActionKind.QuickFix.value,
        );
      } catch (error) {
        if (error?.name === 'Canceled') return false;
        throw error;
      }
      command = actions
        ?.map((action) => (typeof action.command === 'string' ? action : action.command))
        .find((value) => value?.command === 'bve.applyFix');
      return !!command;
    }, 'installed client offers a guarded policy fix');
    return command;
  }
  const apply = (command) =>
    vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
  async function restart() {
    const previous = rememberPid();
    await vscode.commands.executeCommand('backstageValidation.restart');
    await until(
      () => api.status().running && api.status().pid !== previous,
      'restart the installed server',
    );
    const current = rememberPid();
    await until(async () => !(await alive(previous)), 'previous installed server exits');
    note('server-restarted', { previous, current });
  }
  async function cacheRefresh() {
    const launcher = JSON.parse(await readFile(input.configPath, 'utf8'));
    const maxAge = launcher.catalog.maxAgeMs;
    assert(Number.isInteger(maxAge) && maxAge >= 0 && maxAge <= 1000);
    // This wait honors the normal client cache configuration. Catalog readiness
    // is established separately by authenticated reads, not by the timer.
    await delay(maxAge + 25);
    await replace(
      document.getText().replace(/\n# refresh-\d+\n?$/u, '\n') + `\n# refresh-${++generation}\n`,
    );
    note('client-refresh-requested', { version: document.version, maxAgeMs: maxAge });
  }
  async function host(action) {
    const id = randomUUID();
    if (action === 'stop') appStopped = true;
    await save(path.join(input.controlDirectory, 'request.json'), { id, action });
    await until(
      async () => {
        const ack = await readFile(
          path.join(input.controlDirectory, 'acknowledgement.json'),
          'utf8',
        )
          .then(JSON.parse)
          .catch(() => null);
        if (ack?.id !== id) return false;
        assert.equal(ack.status, 'passed', 'The host must finish the requested lifecycle phase.');
        return true;
      },
      'host ' + action + ' acknowledgement',
      60_000,
    );
    note('host-' + action + '-acknowledged');
    appStopped = action === 'stop';
  }
  async function state(name) {
    const seed = JSON.parse(
      await readFile(path.join(input.integrationRoot, 'data', name + '.json'), 'utf8'),
    );
    if (name !== 'baseline') seedChanged = true;
    await renderSeed(seed, '/catalog');
    await refresh(input.base, adminToken);
    const observed = await converge(input.base, seed, readerToken);
    note('catalog-' + name + '-converged', observed);
    seedChanged = name !== 'baseline';
    return seed;
  }
  async function completion(reference) {
    const needle = reference.slice(0, reference.lastIndexOf('/') + 3);
    const text = document.getText();
    const owner = text.indexOf('owner: ') + 'owner: '.length;
    assert(owner >= 'owner: '.length);
    await replace(text.slice(0, owner) + needle + text.slice(text.indexOf('\n', owner)));
    let list;
    await until(async () => {
      list = await vscode.commands.executeCommand(
        'vscode.executeCompletionItemProvider',
        uri,
        document.positionAt(owner + needle.length),
      );
      return list?.items.some(
        (row) => (typeof row.label === 'string' ? row.label : row.label.label) === reference,
      );
    }, 'catalog-backed reference completion');
    return list;
  }
  await checkpoint();
  try {
    assert.equal(vscode.version, input.version, 'Run the requested unmodified editor.');
    assert.equal(vscode.workspace.isTrusted, true);
    const extension = vscode.extensions.getExtension(productId);
    assert(extension, 'Discover the installed product extension.');
    assert(
      path.resolve(extension.extensionPath).startsWith(path.resolve(input.installed) + path.sep),
      'Use the installed VSIX instead of a development override.',
    );
    const build = JSON.parse(
      await readFile(path.join(extension.extensionPath, 'build-info.json'), 'utf8'),
    );
    assert.equal(build.revision, input.revision);
    assert.equal(build.target, 'linux-x64');
    assert.equal(
      vscode.workspace.getConfiguration('backstageValidation').inspect('configPath')?.globalValue,
      input.configPath,
    );
    api = await extension.activate();
    await until(() => api.status().running, 'start the bundled product server');
    rememberPid();
    await open();
    await currentDiagnostic();
    assert(!dependency(), 'Initial authenticated catalog validation must complete.');
    progress.phase = 'run';
    note('installed-client-ready', { pid: api.status().pid, version: document.version });
    await checkpoint();
    if (input.fault === 'crash') await new Promise(() => {});
    switch (input.id) {
      case 'editor.installation': {
        assert(extension.isActive);
        const read = await request(
          input.base,
          '/api/catalog/entities/by-name/group/bve-demo/team-demo',
          { token: readerToken },
        );
        assert.equal(read.status, 200);
        assert.equal(read.body.metadata.name, 'team-demo');
        note('authenticated-backend-read');
        break;
      }
      case 'editor.diagnostics': {
        const diagnostic = await currentDiagnostic();
        assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
        assert.equal(diagnostic.data.category, 'policy');
        assert.equal(diagnostic.data.version, document.version);
        assert(!has('owner-exists'));
        note('versioned-policy-diagnostic', { range: diagnostic.range });
        break;
      }
      case 'editor.completion': {
        const list = await completion('group:bve-demo/team-demo');
        const item = list.items.find((row) => row.label === 'group:bve-demo/team-demo');
        assert(item);
        assert.equal(item.detail, 'Catalog (fresh)');
        note('catalog-reference-completed');
        break;
      }
      case 'editor.guarded-fix': {
        const previous = document.version;
        await apply(await fix());
        await until(
          () => document.getText().includes('lifecycle: "production"'),
          'apply the versioned scalar edit',
        );
        assert(document.version > previous);
        await until(
          () => !has('production-only') && !dependency(),
          'clear the repaired policy finding',
        );
        break;
      }
      case 'editor.unsaved-edits': {
        const disk = await readFile(input.sourceFile, 'utf8');
        await replace(input.validText);
        await until(
          () => !has('production-only') && !dependency(),
          'validate unsaved buffer content',
        );
        assert(document.isDirty);
        assert.equal(await readFile(input.sourceFile, 'utf8'), disk);
        const local =
          input.validText.replace('group:bve-demo/team-demo', 'group:bve-demo/local-only') +
          '\n---\napiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata: {name: local-only, namespace: bve-demo}\nspec: {type: team, children: []}\n';
        await replace(local.replace('lifecycle: production', 'lifecycle: experimental'));
        await currentDiagnostic();
        assert(
          !has('owner-exists') && !dependency(),
          'A valid local proposal must precede the backend catalog.',
        );
        assert.equal(
          (
            await request(input.base, '/api/catalog/entities/by-name/group/bve-demo/local-only', {
              token: readerToken,
            })
          ).status,
          404,
        );
        assert.equal(await readFile(input.sourceFile, 'utf8'), disk);
        note('unsaved-local-proposal-precedence');
        break;
      }
      case 'editor.watcher': {
        assert(input.watchedFile);
        await replace(input.validText);
        await until(
          () => !has('production-only') && !dependency(),
          'start from valid local watched ownership',
        );
        assert(document.isDirty);
        assert.equal(await document.save(), true, 'Save through the installed editor.');
        await until(
          async () => (await readFile(input.sourceFile, 'utf8')) === input.validText,
          'native save updates approved disk bytes',
        );
        assert.equal(document.isDirty, false);
        await writeFile(input.watchedFile, input.invalidGroupText);
        await until(
          () => has('owner-exists'),
          'native watcher observes the invalid closed dependency',
        );
        await writeFile(input.watchedFile, input.groupText);
        await until(
          () => !has('owner-exists') && !dependency(),
          'native watcher observes dependency repair',
        );
        assert.equal(document.getText(), input.validText);
        assert.equal(document.isDirty, false);
        note('native-save-and-closed-dependency-watcher-repaired');
        break;
      }
      case 'editor.stale-fix': {
        const command = await fix();
        await replace(document.getText() + '\n# intervening unsaved edit\n');
        await currentDiagnostic();
        const text = document.getText();
        const version = document.version;
        assert.deepEqual(await apply(command), { applied: false, reason: 'stale' });
        assert.equal(document.getText(), text);
        assert.equal(document.version, version);
        note('stale-command-rejected-with-buffer-preserved');
        break;
      }
      case 'editor.restart': {
        const text = document.getText();
        await restart();
        await currentDiagnostic();
        assert.equal(document.getText(), text);
        assert(!dependency());
        break;
      }
      case 'editor.mutation': {
        await replace(
          input.invalidText.replace('group:bve-demo/team-demo', 'group:bve-demo/team-next'),
        );
        await currentDiagnostic('owner-exists');
        assert.equal(
          snapshot().find((row) => codeOf(row) === 'owner-exists').severity,
          vscode.DiagnosticSeverity.Error,
        );
        await state('mutation');
        await cacheRefresh();
        await currentDiagnostic();
        await until(
          () => !has('owner-exists') && !dependency(),
          'client observes the ingested catalog addition',
        );
        note('client-mutation-converged', { version: document.version });
        await state('baseline');
        await cacheRefresh();
        await currentDiagnostic('owner-exists');
        note('client-baseline-restored');
        break;
      }
      case 'editor.permission-denied': {
        assert.equal(
          (
            await request(input.base, '/api/catalog/entities/by-name/group/bve-demo/team-demo', {
              token: deniedToken,
            })
          ).status,
          403,
        );
        const launcher = JSON.parse(await readFile(input.configPath, 'utf8'));
        const previous = { ...launcher.catalog };
        try {
          Object.assign(launcher.catalog, {
            tokenEnv: 'BVE_BACKSTAGE_DENIED_TOKEN',
            principalId: 'bve-denied',
            credentialRevision: 'denied-1',
          });
          await save(input.configPath, launcher);
          await restart();
          await until(
            () => dependency(),
            'actual authorization denial produces a dependency warning',
          );
          assert(
            snapshot()
              .filter((row) => row.data?.category === 'dependency')
              .every((row) => row.severity === vscode.DiagnosticSeverity.Warning),
          );
          note('actual-authorization-denied');
        } finally {
          launcher.catalog = previous;
          await save(input.configPath, launcher);
          await restart();
        }
        await currentDiagnostic();
        await until(() => !dependency(), 'reader credentials recover validation');
        break;
      }
      case 'editor.outage-recovery': {
        const pid = rememberPid();
        await host('stop');
        await assert.rejects(
          request(input.base, '/api/catalog/entities/by-name/group/bve-demo/team-demo', {
            token: readerToken,
          }),
        );
        await cacheRefresh();
        await until(() => dependency(), 'offline backend produces a dependency warning');
        const diag = snapshot().find((row) => row.data?.category === 'dependency');
        const actions = await vscode.commands.executeCommand(
          'vscode.executeCodeActionProvider',
          uri,
          diag.range,
          vscode.CodeActionKind.QuickFix.value,
        );
        assert(
          !(actions ?? []).some(
            (action) =>
              (typeof action.command === 'string' ? action.command : action.command?.command) ===
              'bve.applyFix',
          ),
        );
        await host('start');
        const baseline = JSON.parse(
          await readFile(path.join(input.integrationRoot, 'data/baseline.json'), 'utf8'),
        );
        await converge(input.base, baseline, readerToken);
        await cacheRefresh();
        await currentDiagnostic();
        await until(() => !dependency(), 'the same server recovers after the backend returns');
        assert.equal(rememberPid(), pid);
        await fix();
        note('outage-recovered-with-same-server', { pid });
        break;
      }
      case 'editor.parity': {
        await currentDiagnostic();
        await fix();
        const diagnostics = snapshot();
        assert(diagnostics.every((row) => row.data?.version === document.version));
        let observation;
        const digest = 'sha256:' + createHash('sha256').update(document.getText()).digest('hex');
        await until(async () => {
          observation = await api.coverage(uri.toString(), document.version, digest);
          return observation !== null;
        }, 'current host coverage observation');
        progress.result = {
          coverageObservation: observation,
          text: document.getText(),
          sourceUri: uri.toString(),
          version: document.version,
          findings: diagnostics.map((row) => ({
            ruleId: codeOf(row),
            category: row.data.category,
            findingId: row.data.findingId,
            uri: uri.toString(),
            range: {
              start: { line: row.range.start.line, character: row.range.start.character },
              end: { line: row.range.end.line, character: row.range.end.character },
            },
          })),
        };
        break;
      }
      default:
        throw new Error('Undeclared editor case.');
    }
    progress.status = 'passed';
  } catch (error) {
    progress.status = 'failed';
    progress.failure = { name: error.name, message: 'Required installed-editor assertion failed.' };
    progress.screenshotRequested = true;
    await checkpoint();
    await until(
      async () => !!(await readFile(input.screenshotAcknowledgement, 'utf8').catch(() => '')),
      'parent failure screenshot',
      6000,
    ).catch(() => {});
    console.error(error);
  } finally {
    progress.phase = 'cleanup';
    await checkpoint();
    try {
      if (appStopped) await host('start');
      if (seedChanged) await state('baseline');
      if (api) {
        const pid = api.status().pid;
        if (pid && !progress.serverPids.includes(pid)) progress.serverPids.push(pid);
        await vscode.commands.executeCommand('backstageValidation.stop');
      }
      for (const pid of progress.serverPids)
        await until(async () => !(await alive(pid)), 'owned packaged server exits');
      progress.cleanup.status = 'passed';
      progress.phase = 'complete';
    } catch (error) {
      progress.status = 'failed';
      progress.cleanup = { status: 'failed', name: error.name };
      console.error(error);
    }
    await checkpoint();
  }
  assert.equal(progress.status, 'passed', 'Installed-editor case failed.');
  assert.equal(progress.cleanup.status, 'passed');
  console.log('Real Backstage installed-editor case passed: ' + input.id);
}
