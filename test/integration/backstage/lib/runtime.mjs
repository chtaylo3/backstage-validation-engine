import assert from 'node:assert/strict';
import { chown, chmod, lstat, mkdir } from 'node:fs/promises';

// These paths belong to this run's two named volumes. Never follow a replacement link.
export async function initializeRuntime(uid, gid) {
  assert(Number.isSafeInteger(uid) && uid > 0, 'Use a non-root runtime user.');
  assert(Number.isSafeInteger(gid) && gid >= 0, 'Use a valid runtime group.');
  for (const [directory, mode] of [
    ['/catalog', 0o755],
    ['/run/work', 0o700],
    ['/run/work/home', 0o700],
    ['/run/work/npm-cache', 0o700],
    ['/run/work/editor', 0o700],
    ['/run/work/editor/downloads', 0o700],
  ]) {
    await mkdir(directory, { recursive: true, mode });
    assert((await lstat(directory)).isDirectory(), 'Use an owned runtime directory.');
    await chown(directory, uid, gid);
    await chmod(directory, mode);
  }
}
