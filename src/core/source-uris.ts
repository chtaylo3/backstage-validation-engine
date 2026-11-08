import { fileURLToPath, pathToFileURL } from 'node:url';

/** Snapshot-local names have one platform spelling; no filesystem/symlink resolution occurs. */
export function isCanonicalSourceUri(value: string, directory = false): boolean {
  try {
    const uri = new URL(value);
    if (uri.protocol !== 'file:' || uri.host || uri.search || uri.hash || uri.href !== value)
      return false;
    const path = decodeURIComponent(uri.pathname);
    if (/[\\%\p{Cc}]/u.test(path) || path.endsWith('/') !== directory) return false;
    const segments = path.split('/');
    if (
      segments
        .slice(1, directory ? -1 : undefined)
        .some(
          (part, index) =>
            !part ||
            part === '.' ||
            part === '..' ||
            (part.includes(':') && !(index === 0 && /^[A-Za-z]:$/.test(part))),
        )
    )
      return false;
    // Node encodes Windows short-name tildes as %7E. Use its platform-specific
    // codec even on other hosts, while keeping POSIX snapshot names portable.
    const windows = /^\/[A-Za-z]:\//u.test(path);
    return pathToFileURL(fileURLToPath(uri, { windows }), { windows }).href === value;
  } catch {
    return false;
  }
}
