import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { writeEvidence } from './evidence.js';
import path from 'node:path';
import * as vscode from 'vscode';
import { until, exited } from './fixture.js';
import type { Fixture } from './fixture.js';
import { resources, ownedServers } from './resources.js';
interface Sample {
  elapsedMs: number;
  operation: number;
  client: { rssMiB: number; handles: number };
  server: { rssMiB: number; handles: number };
  pid: number;
}
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
  const samples: Sample[] = [];
  const edits: number[] = [],
    completions: number[] = [],
    restarts: number[] = [];
  const directory = path.dirname(process.env.BVE_EXTENSION_TEST_PROGRESS!);
  let operation = 0,
    lastRestart = 0,
    interruptions = 0,
    completed = false;
  const budgets = {
    coldMs: 20_000,
    editP95Ms: 20_000,
    completionP95Ms: 20_000,
    restartP95Ms: 20_000,
    clientGrowthMiB: 128,
    serverGrowthMiB: 128,
    handleGrowth: 64,
    growthMiBPerOperation: 0.15,
  };
  const cadenceMs = duration === 60 ? 15_000 : 60_000;
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
      baseline,
      coldMs,
      budgets,
      percentiles: {
        editP95Ms: edits.length ? percentile(edits, 0.95) : null,
        completionP95Ms: completions.length ? percentile(completions, 0.95) : null,
        restartP95Ms: restarts.length ? percentile(restarts, 0.95) : null,
      },
      samples,
    };
    const file = path.join(directory, 'resource-metrics.json');
    await writeEvidence(file, JSON.stringify(report, null, 2) + '\n');
  }
  try {
    do {
      const before = Date.now();
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
        const text = await readFile(fixture.teamUri.fsPath, 'utf8');
        for (let burst = 0; burst < 3; burst++)
          await writeFile(fixture.teamUri.fsPath, text + `# watcher ${operation}:${burst}\n`);
        await fixture.currentDiagnostic(document);
        assert(document.getText().includes(`# operation ${operation}, burst 2`));
      }
      if (soak && (interruptions === 0 || Date.now() - lastRestart > cadenceMs)) {
        const outage = await fixture.control({
          op: 'outage',
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
        await fixture.control({ op: 'recover' });
        await vscode.commands.executeCommand('backstageValidation.restart');
        await until(() => fixture.api!.status().running, 'catalog recovery restart');
        fixture.pid();
        await until(
          () =>
            !vscode.languages
              .getDiagnostics(document.uri)
              .some((row) => row.code === 'validation/incomplete' || row.code === 'owner-exists'),
          'recovered catalog finding clears',
        );
        await fixture.replace(document, original + `# operation ${operation}\n`);
        await fixture.currentDiagnostic(document);
        interruptions++;
      }
      if (
        (!soak && [20, 40].includes(operation)) ||
        (soak && Date.now() - lastRestart > cadenceMs)
      ) {
        const pid = fixture.pid(),
          restartStarted = Date.now();
        await vscode.commands.executeCommand('backstageValidation.restart');
        await until(
          () => exited(pid) && fixture.api!.status().running,
          'bounded restart under workload',
        );
        fixture.pid();
        await fixture.currentDiagnostic(document);
        restarts.push(Date.now() - restartStarted);
        lastRestart = Date.now();
      }
      if (soak || operation % 3 === 0) {
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
    // Compare after warmup, and compare each server generation independently.
    for (const side of ['client', 'server'] as const) {
      let measuredGenerations = 0;
      const generations =
        side === 'client'
          ? [samples]
          : [...new Set(samples.map((row) => row.pid))].map((pid) =>
              samples.filter((row) => row.pid === pid),
            );
      for (const generation of generations) {
        if (generation.length < 5) continue;
        measuredGenerations++;
        const warm = generation.slice(Math.floor(generation.length / 4));
        const first = warm[0]!,
          last = warm.at(-1)!;
        const growth = last[side].rssMiB - first[side].rssMiB;
        assert(
          growth <= budgets[side === 'client' ? 'clientGrowthMiB' : 'serverGrowthMiB'],
          side + ' retained RSS must plateau',
        );
        assert(
          last[side].handles - first[side].handles <= budgets.handleGrowth,
          side + ' handle growth',
        );
        if (last.operation - first.operation >= 100) {
          const meanX = warm.reduce((sum, row) => sum + row.operation, 0) / warm.length;
          const meanY = warm.reduce((sum, row) => sum + row[side].rssMiB, 0) / warm.length;
          const slope =
            warm.reduce(
              (sum, row) => sum + (row.operation - meanX) * (row[side].rssMiB - meanY),
              0,
            ) / warm.reduce((sum, row) => sum + (row.operation - meanX) ** 2, 0);
          assert(slope <= budgets.growthMiBPerOperation, side + ' growth per operation');
        }
      }
      if (duration !== 60)
        assert(
          measuredGenerations > 0,
          side + ' needs enough samples in a live generation to measure plateau',
        );
    }
    if (soak)
      assert(interruptions > 1, 'A soak must exercise repeated catalog interruption and recovery.');
    completed = true;
  } finally {
    await persist(completed);
  }
}
