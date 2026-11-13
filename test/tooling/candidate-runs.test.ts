import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

interface Run {
  id: number;
  head_sha: string;
  event: string;
  conclusion: string | null;
}
const { selectCandidateRun } = (await import(
  pathToFileURL(path.resolve('scripts/candidate-runs.mjs')).href
)) as { selectCandidateRun: (runs: Run[], revision: string) => Run | undefined };

const revision = 'a'.repeat(40);
const run = (id: number, event: string, conclusion: string | null = null): Run => ({
  id,
  head_sha: revision,
  event,
  conclusion,
});

void test('candidate selection excludes PR merge artifacts even when the API reports the same head', () => {
  const push = run(1, 'push', 'success');
  assert.equal(selectCandidateRun([run(2, 'pull_request'), push], revision), push);
});

void test('candidate selection accepts an active explicit dispatch ahead of a push', () => {
  const dispatch = run(3, 'workflow_dispatch');
  assert.equal(selectCandidateRun([dispatch, run(1, 'push', 'success')], revision), dispatch);
});

void test('candidate selection ignores cancelled runs and different source revisions', () => {
  const push = run(1, 'push', 'success');
  assert.equal(
    selectCandidateRun(
      [{ ...run(4, 'push'), head_sha: 'b'.repeat(40) }, run(3, 'push', 'cancelled'), push],
      revision,
    ),
    push,
  );
});

void test('candidate selection cannot substitute an unsupported trigger or a PR-only artifact', () => {
  assert.equal(
    selectCandidateRun([run(3, 'pull_request_target'), run(2, 'pull_request')], revision),
    undefined,
  );
});
