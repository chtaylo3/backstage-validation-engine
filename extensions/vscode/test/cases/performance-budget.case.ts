import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import * as vscode from 'vscode';
import { performance } from 'node:perf_hooks';
import { until, bounded } from '../fixture.js';
import type { Fixture } from '../fixture.js';
import { METRIC_BUDGETS } from '../qualification.js';
import { suspendServer } from '../native-process.js';
import { writeEvidence } from '../evidence.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  await fixture.currentDiagnostic(document);
  const completion = () =>
    fixture.provider<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      new vscode.Position(6, 11),
    );
  const present = (value: vscode.CompletionList) =>
    value.items.some((item) => item.label === 'group:default/team');
  const positiveStarted = performance.now();
  assert(present(await completion()), 'Real completion succeeds before the induced fault.');
  const positiveElapsedMs = performance.now() - positiveStarted;
  await until(
    async () => (await fixture.trace()).includes("Received response 'textDocument/completion"),
    'positive completion response reaches the trace',
  );
  const pid = fixture.pid();
  const before = await fixture.trace();
  const previousId = Number(
    [...before.matchAll(/Sending request 'textDocument\/completion - \((\d+)\)'/gu)].at(-1)![1],
  );
  const offset = before.length;
  const resume = await suspendServer(pid);
  let pending: Promise<vscode.CompletionList> | undefined;
  let requestId: number | undefined;
  const started = performance.now();
  try {
    pending = completion();
    await until(async () => {
      const trace = (await fixture.trace()).slice(offset);
      const request = /Sending request 'textDocument\/completion - \((\d+)\)'/u.exec(trace);
      if (request) requestId = Number(request[1]);
      return requestId !== undefined && requestId > previousId;
    }, 'new correlated completion request queued while owned server is suspended');
    // This timer injects a defined latency fault after the ordered request barrier.
    await pause(METRIC_BUDGETS.completionP95Ms + 250);
  } finally {
    await resume();
  }
  assert(pending);
  const result = await bounded(
    pending,
    'actual completion after induced delay',
    60_000 - (performance.now() - started),
  );
  const elapsedMs = performance.now() - started;
  assert(present(result), 'The delayed operation completed with a real nonempty provider result.');
  assert(elapsedMs < 60_000, 'The observation deadline remains separate from the budget.');
  assert.throws(
    () =>
      assert(
        elapsedMs <= METRIC_BUDGETS.completionP95Ms,
        'completionP95Ms exceeds the host budget',
      ),
    /completionP95Ms exceeds the host budget/,
  );
  assert.equal(fixture.pid(), pid);
  await writeEvidence(
    path.join(
      path.dirname(process.env.BVE_EXTENSION_TEST_PROGRESS!),
      'latency-negative-control.json',
    ),
    JSON.stringify(
      {
        kind: 'deliberately induced single-operation latency negative control',
        elapsedMs,
        positiveElapsedMs,
        requestId,
        budgetMs: METRIC_BUDGETS.completionP95Ms,
        observationTimeoutMs: 60_000,
        resultPresent: true,
        assertionRejected: true,
        pid,
        performanceQualification: false,
      },
      null,
      2,
    ) + '\n',
  );
}
