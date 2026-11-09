import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      steps?: { uses?: string; run?: string; with?: Record<string, string | boolean> }[];
      env?: Record<string, string>;
      uses?: string;
      if?: string;
      needs?: string[];
      with?: Record<string, string | boolean>;
    }
  >;
}
const load = async (name: string) =>
  parse(await readFile('.github/workflows/' + name, 'utf8')) as Workflow;

void test('real Backstage Docker builds require explicit candidate dispatch and matching workflow SHA', async () => {
  const workflow = await load('backstage-release-qualification.yml');
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch', 'workflow_call']);
  const dispatch = workflow.on.workflow_dispatch as { inputs: { revision: { required: boolean } } };
  assert.equal(dispatch.inputs.revision.required, true);
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' });
  const job = workflow.jobs.backstage;
  assert(job);
  assert(job.steps);
  assert.equal(job.if, "${{ github.event_name == 'workflow_dispatch' }}");
  assert.equal(job.env?.BVE_REQUESTED_REVISION, '${{ inputs.revision }}');
  const commands = job.steps.map((step) => step.run ?? '').join('\n');
  assert.match(commands, /assert\.equal\(revision, process\.env\.GITHUB_SHA/u);
  assert.match(commands, /use-cli-candidate\.mjs/u);
  assert.match(commands, /use-extension-candidate\.mjs --os=ubuntu-24\.04/u);
  assert.match(commands, /backstage-test-env\.mjs", "release"/u);
  assert.match(commands, /"--cli=" \+ cli\.archive/u);
  assert.match(commands, /"--vsix=" \+ editor\.vsix/u);
  assert.match(commands, /backstage-test-env\.mjs clean/u);
  for (const step of job.steps)
    if (step.uses)
      assert.match(step.uses, /@[0-9a-f]{40}$/u, 'Actions require immutable source pins.');
});

void test('ordinary CI packages exact CLI candidates without starting optional Backstage infrastructure', async () => {
  const workflow = await load('ci.yml');
  const allCommands = Object.values(workflow.jobs)
    .flatMap((job) => (job.steps ?? []).map((step) => step.run ?? ''))
    .join('\n');
  assert.doesNotMatch(allCommands, /\bdocker\b|backstage-test-env\.mjs|test:backstage:release/u);
  const cli = workflow.jobs.cli;
  assert(cli?.steps);
  assert(cli.steps.some((step) => step.run === 'npm run cli:package'));
  const upload = cli.steps.find((step) => step.with?.name === 'cli-candidate');
  assert(upload);
  assert.match(String(upload.with?.path), /\*\.tgz\.metadata\.json/u);
  assert.match(String(upload.with?.path), /\*\.tgz\.sha256/u);
  assert.equal(upload.with?.['if-no-files-found'], 'error');
});

void test('release uploads include only declared sanitized report paths', async () => {
  const workflow = await load('backstage-release-qualification.yml');
  const upload = workflow.jobs.backstage?.steps?.find(
    (step) => step.with?.name === 'backstage-release-qualification',
  );
  assert(upload);
  assert.equal(upload.with?.['if-no-files-found'], 'error');
  const paths = String(upload.with?.path).trim().split('\n');
  assert.equal(paths.length, 3);
  assert(paths.every((entry) => /\/(?:results\.json|junit\.xml|reports\/)$/u.test(entry)));
  assert(paths.every((entry) => !/credential|sqlite|\*\*/iu.test(entry)));
});

void test('every reusable Backstage caller requires manual release approval and exact candidate input', async () => {
  const ci = await load('ci.yml');
  const manual = ci.on.workflow_dispatch as {
    inputs: { qualify_backstage: { type: string; default: boolean } };
  };
  assert.deepEqual(manual.inputs.qualify_backstage.type, 'boolean');
  assert.equal(manual.inputs.qualify_backstage.default, false);
  const callers = [];
  for (const name of (await readdir('.github/workflows')).filter((file) =>
    /\.ya?ml$/u.test(file),
  )) {
    const workflow = await load(name);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (job.uses !== './.github/workflows/backstage-release-qualification.yml') continue;
      callers.push(name + '/' + id);
      assert.equal(
        job.if,
        "${{ github.event_name == 'workflow_dispatch' && inputs.qualify_backstage == true }}",
      );
      assert.equal(job.with?.revision, '${{ inputs.revision }}');
      assert.deepEqual(job.needs, ['cli', 'vscode']);
    }
  }
  assert.deepEqual(callers, ['ci.yml/backstage_release']);
});
