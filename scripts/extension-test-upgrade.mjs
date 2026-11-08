import { spawn } from 'node:child_process';
import { cp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
let pending;
/** A same-revision fixture predecessor tests the upgrade mechanism, not historical compatibility. */
export function previousFixture(root, info) {
  pending ??= (async () => {
    const directory = path.join(root, '.artifacts/vscode/previous-fixture-stage');
    const vsix = path.join(root, '.artifacts/vscode/previous-fixture.vsix');
    await rm(directory, { recursive: true, force: true });
    await cp(info.stage, directory, { recursive: true });
    const manifestFile = path.join(directory, 'package.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.version = '0.0.1';
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          path.join(root, 'node_modules/@vscode/vsce/vsce'),
          'package',
          '--no-dependencies',
          '--target',
          info.target,
          '--out',
          vsix,
        ],
        { cwd: directory, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true },
      );
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error('Fixture predecessor packaging failed: ' + code)),
      );
    });
    await writeFile(
      vsix + '.sha256',
      createHash('sha256')
        .update(await readFile(vsix))
        .digest('hex') +
        '  ' +
        path.basename(vsix) +
        '\n',
    );
    return vsix;
  })();
  return pending;
}
