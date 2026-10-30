/** Snapshot-local names have one file-URI spelling; no filesystem or symlink resolution occurs. */
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
    const canonical = new URL('file:///');
    canonical.pathname = path;
    return canonical.href === value;
  } catch {
    return false;
  }
}
