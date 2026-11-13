import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { writeEvidence } from './evidence.js';
import path from 'node:path';
import * as vscode from 'vscode';
import { until, exited } from './fixture.js';
import type { Fixture } from './fixture.js';
import { resources, ownedServers, verifyResourceGrowth } from './resources.js';
import type { ResourceSample as Sample } from './resources.js';
import { METRIC_BUDGETS } from './qualification.js';
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]!;
export async function endurance(fixture: Fixture, soak = false): Promise<void> {
  const duration = soak ? Number(process.env.BVE_SOAK_SECONDS) : 0;
  assert(!soak || (Number.isInteger(duration) && duration >= 60 && duration <= 7200));
  const size = Number(process.env.BVE_EXTENSION_TEST_FILE_COUNT);
  assert(size === 100 || size === 1000);
  const config = JSON.parse(await readFile(process.env.BVE_EXTENSION_TEST_CONFIG!, 'utf8')) as {
    source: { files: unknown[] };
  };
  assert.equal(config.source.files.length, size);
  const extension = vscode.extensions.getExtension('chtaylo3.backstage-validation-engine')!;
  const started = Date.now();
  await fixture.setup();
  const document = await fixture.document();
  await fixture.currentDiagnostic(document);
  const coldMs = Date.now() - Number(process.env.BVE_EXTENSION_TEST_LAUNCHED_AT);
  const initialPid = fixture.pid();
  await vscode.commands.executeCommand('backstageValidation.stop');
  await until(() => exited(initialPid), 'stop before measuring the idle extension host');
  const baseline = await resources(process.pid);
  await vscode.commands.executeCommand('backstageValidation.restart');
  await until(() => fixture.api!.status().running, 'start measured workload server');
  fixture.pid();
  await fixture.currentDiagnostic(document);
  const workloadStarted = Date.now();
  const original = document.getText();
  const teamText = await readFile(fixture.teamUri.fsPath, 'utf8');
  const samples: Sample[] = [];
  const edits: number[] = [],
    completions: number[] = [],
    restarts: number[] = [];
  const directory = path.dirname(process.env.BVE_EXTENSION_TEST_PROGRESS!);
  let operation = 0,
    lastRestart = workloadStarted,
    lastInterruption = 0,
    catalogIndex = 0,
    interruptions = 0,
    completed = false;
  const budgets = METRIC_BUDGETS;
  const cadenceMs = duration === 60 ? 15_000 : 60_000;
  const restartCadenceMs = duration === 60 ? 15_000 : 15 * 60_000;
  const catalogVersions = new Set<string>();
  async function persist(complete = false) {
    const report = {
      complete,
      size,
      durationSeconds: duration,
      elapsedMs: Date.now() - started,
      workloadElapsedMs: Date.now() - workloadStarted,
      baselineKind: 'extension host after product Stop',
      debounceMs: 25,
      fixture: { components: size - 1, groups: 1, initialPolicyViolations: 1 },
      operation,
      interruptions,
      catalogVersionsObserved: [...catalogVersions],
      baseline,
      coldMs,
      budgets,
      percentiles: {
        editP95Ms: edits.length ? percentile(edits, 0.95) : null,
        completionP95Ms: completions.length ? percentile(completions, 0.95) : null,
        restartP95Ms: restarts.length ? percentile(restarts, 0.95) : null,
      },
      latencies: { edits, completions, restarts },
      samples,
    };
    const file = path.join(directory, 'resource-metrics.json');
    await writeEvidence(file, JSON.stringify(report, null, 2) + '\n');
  }
  try {
    do {
      const before = Date.now();
      let restarted = false;
      // A burst must coalesce to the current version, without losing the dirty buffer.
      for (let burst = 0; burst < 3; burst++)
        await fixture.replace(document, original + `# operation ${operation}, burst ${burst}\n`);
      await fixture.currentDiagnostic(document);
      edits.push(Date.now() - before);
      const completionStarted = Date.now();
      await until(async () => {
        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider',
          document.uri,
          new vscode.Position(6, 11),
        );
        return list?.items.some((row) => row.label === 'group:default/team') === true;
      }, 'warm reference completion under load');
      completions.push(Date.now() - completionStarted);
      if (operation % 5 === 0) {
        // Native watcher burst in another configured file while the main document is dirty.
        for (let burst = 0; burst < 3; burst++)
          await writeFile(fixture.teamUri.fsPath, teamText + `# watcher ${operation}:${burst}\n`);
        await fixture.currentDiagnostic(document);
        assert(document.getText().includes(`# operation ${operation}, burst 2`));
      }
      if (soak && (interruptions === 0 || Date.now() - lastInterruption > cadenceMs)) {
        const outage = await fixture.control({
          op: 'outage',
          version: catalogIndex,
          operation: 'byName',
          entityRef: 'group:default/remote-team',
        });
        assert(outage.reference);
        await fixture.replace(
          document,
          document
            .getText()
            .replace('owner: team', 'owner: ' + outage.reference)
            .replace('lifecycle: experimental', 'lifecycle: production'),
        );
        await until(
          () =>
            vscode.languages
              .getDiagnostics(document.uri)
              .some(
                (row) =>
                  row.code === 'owner-exists' &&
                  (row as vscode.Diagnostic & { data?: { category: string } }).data?.category ===
                    'dependency',
              ),
          'catalog interruption is reported as incomplete',
        );
        const pid = fixture.pid();
        const recovery = await fixture.control({ op: 'recover', version: catalogIndex });
        await fixture.replace(
          document,
          document.getText() + `# catalog recovered ${interruptions}\n`,
        );
        await until(
          () =>
            !vscode.languages
              .getDiagnostics(document.uri)
              .some((row) => row.code === 'validation/incomplete' || row.code === 'owner-exists'),
          'recovered catalog finding clears',
        );
        await fixture.control({
          op: 'assert-read',
          version: catalogIndex,
          after: Number(recovery.id),
        });
        assert.equal(
          fixture.pid(),
          pid,
          'Catalog recovery does not hide growth by restarting the server.',
        );
        catalogVersions.add(fixture.catalogs()[catalogIndex]!.version);
        await fixture.replace(document, original + `# operation ${operation}\n`);
        await fixture.currentDiagnostic(document);
        interruptions++;
        lastInterruption = Date.now();
      }
      if (
        (!soak && [20, 40].includes(operation)) ||
        (soak && Date.now() - lastRestart > restartCadenceMs)
      ) {
        const pid = fixture.pid(),
          restartStarted = Date.now();
        if (soak) {
          catalogIndex = (catalogIndex + 1) % fixture.catalogs().length;
          await fixture.useCatalog(catalogIndex);
        } else await vscode.commands.executeCommand('backstageValidation.restart');
        await until(
          () => exited(pid) && fixture.api!.status().running,
          'bounded restart under workload',
        );
        fixture.pid();
        await fixture.currentDiagnostic(document);
        restarts.push(Date.now() - restartStarted);
        lastRestart = Date.now();
        restarted = true;
      }
      if (soak || operation % 3 === 0 || restarted) {
        const pid = fixture.pid();
        assert.deepEqual(
          await ownedServers(extension.extensionPath),
          [pid],
          'Exactly one packaged server is owned by this extension host.',
        );
        const [client, server] = await Promise.all([resources(process.pid), resources(pid)]);
        assert(Number.isFinite(client.rssMiB) && Number.isFinite(server.rssMiB));
        samples.push({ elapsedMs: Date.now() - started, operation, client, server, pid });
        await persist();
      }
      operation++;
      if (soak) await new Promise<void>((resolve) => setTimeout(resolve, 300));
    } while (soak ? Date.now() - workloadStarted < duration * 1000 : operation < 60);
    assert(coldMs <= budgets.coldMs);
    assert(percentile(edits, 0.95) <= budgets.editP95Ms);
    assert(percentile(completions, 0.95) <= budgets.completionP95Ms);
    assert(restarts.length && percentile(restarts, 0.95) <= budgets.restartP95Ms);
    assert(samples.length >= (duration === 60 ? 3 : 8));
    verifyResourceGrowth(samples, budgets, duration !== 60, soak && duration !== 60);
    if (soak)
      assert(interruptions > 1, 'A soak must exercise repeated catalog interruption and recovery.');
    completed = true;
  } finally {
    await persist(completed);
  }
}
