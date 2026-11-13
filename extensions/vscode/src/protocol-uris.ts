import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The spellings that the trusted configuration gives to local files.
 *
 * The language server compares document URIs with the configuration as exact strings. The editor
 * spells the same file differently: it lower-cases a Windows drive letter and percent-encodes the
 * colon after it. The client therefore sends every local file in the configuration's spelling.
 */
export interface ConfiguredSpellings {
  /** The configured URI of each listed file, by `pathKey` of its local path. */
  readonly files: Map<string, string>;
  /** The local paths of the configured root directories, resolved as the server resolves them. */
  readonly roots: string[];
}

export function configuredSpellings(): ConfiguredSpellings {
  return { files: new Map(), roots: [] };
}

/** The identity of a local path: Windows paths match without regard to case. */
export function pathKey(fsPath: string, windows = process.platform === 'win32'): string {
  return windows ? fsPath.toLowerCase() : fsPath;
}

/** Records a configured root directory URI. The caller has checked that it is a `file:` URI. */
export function addRoot(
  spellings: ConfiguredSpellings,
  rootUri: string,
  windows = process.platform === 'win32',
): void {
  const local = windows ? path.win32 : path.posix;
  spellings.roots.push(local.resolve(fileURLToPath(rootUri, { windows })));
}

/**
 * The URI that the client sends to the server for a local file.
 *
 * A listed file keeps its configured spelling. Any other file below a configured root is spelled
 * as the server's discovery spells it: the root's own path joined with the file's path below the
 * root. The most specific root wins, so a file below a nested root takes that root's spelling. A
 * file outside every root keeps the spelling of its own path.
 */
export function protocolFileUri(
  fsPath: string,
  spellings: ConfiguredSpellings,
  windows = process.platform === 'win32',
): string {
  const listed = spellings.files.get(pathKey(fsPath, windows));
  if (listed !== undefined) return listed;
  const local = windows ? path.win32 : path.posix;
  let spelled = fsPath;
  let depth = -1;
  for (const root of spellings.roots) {
    const below = local.relative(root, fsPath);
    if (
      below === '' ||
      local.isAbsolute(below) ||
      below === '..' ||
      below.startsWith('..' + local.sep) ||
      root.length <= depth
    )
      continue;
    spelled = local.join(root, below);
    depth = root.length;
  }
  return pathToFileURL(spelled, { windows }).href;
}
