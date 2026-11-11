import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as engine from '../../src/index.js';
import type { Immutable, Coverage } from '../../src/index.js';
export const { verifyCliReport, verifyCoverageParity } = (await import(
  pathToFileURL(path.resolve('test/integration/backstage/lib/client-contracts.mjs')).href
)) as {
  verifyCliReport: (
    runtime: typeof engine,
    report: unknown,
    expected: {
      variant: 'validation' | 'error' | 'sarif';
      exitCode?: number;
      outcome?: string;
      provenance?: Record<string, string>;
    },
  ) => void;
  verifyCoverageParity: (
    cli: readonly Immutable<Coverage>[],
    editor: readonly Immutable<Coverage>[],
  ) => void;
};
