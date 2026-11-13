import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { selectInstalledModules } from './extension-test-selection.mjs';

const modules = (await readdir('extensions/vscode/test/cases'))
  .filter((name) => name.endsWith('.case.ts'))
  .map((name) => name.replace(/\.ts$/u, '.cjs'))
  .sort();
/** @type {{ cases: { scope: string }[], editorVersions: string[] }} */
const backstage = JSON.parse(await readFile('test/integration/backstage/cases.json', 'utf8'));
const targets = Object.keys(
  JSON.parse(await readFile('test/integration/backstage/targets.json', 'utf8')).targets,
).sort();
const scopes = Object.fromEntries(
  ['environment', 'cli', 'editor', 'runner'].map((scope) => [
    scope,
    backstage.cases.filter((row) => row.scope === scope).length,
  ]),
);
const perTarget = backstage.cases.reduce(
  (sum, row) => sum + (row.scope === 'editor' ? backstage.editorVersions.length : 1),
  0,
);
console.log(
  JSON.stringify(
    {
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      trackedChanges:
        execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
          encoding: 'utf8',
        }).trim() !== '',
      mode: 'inventory-only; no execution qualification',
      installed: {
        client: 'VS Code',
        platform: 'declared desktop selectors; no platform execution',
        modules: modules.length,
        portable: selectInstalledModules(modules).length,
        portableIds: selectInstalledModules(modules),
      },
      backstage: {
        client: 'packaged CLI and installed VS Code',
        platform: 'Linux x64 release definition',
        declared: backstage.cases.length,
        scopes,
        editors: backstage.editorVersions,
        targets,
        perTarget,
        total: perTarget * targets.length,
      },
    },
    null,
    2,
  ),
);
