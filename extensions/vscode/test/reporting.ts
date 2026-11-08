export interface CaseSpec {
  id: string;
  version: string;
}
export type Phase = 'launch' | 'setup' | 'run' | 'cleanup' | 'complete';
export interface Progress {
  id: string;
  editorVersion?: string;
  phase: Phase;
  status: 'running' | 'passed' | 'failed';
  error?: string;
  serverPids: number[];
  readinessCancellations?: number;
  observations?: { event: string; at: number }[];
}
export interface Outcome {
  exitCode: number;
  progress?: Progress;
  error?: string;
}
export interface CaseResult extends CaseSpec {
  status: 'unexecuted' | 'running' | 'passed' | 'failed';
  phase: Phase;
  durationMs: number;
  error?: string;
}
export interface Report {
  metadata: Record<string, unknown>;
  conclusion: 'running' | 'success' | 'failure';
  counts: {
    discovered: number;
    executed: number;
    passed: number;
    failed: number;
    unexecuted: number;
  };
  cases: CaseResult[];
}
const describe = (error: unknown) =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

export function classify(
  spec: CaseSpec,
  outcome: Outcome,
): Pick<CaseResult, 'status' | 'phase' | 'error'> {
  const progress = outcome.progress;
  if (progress?.id !== spec.id)
    return {
      status: 'failed',
      phase: 'launch',
      error: outcome.error ?? 'Missing or mismatched editor case report.',
    };
  if (
    outcome.exitCode === 0 &&
    progress.status === 'passed' &&
    progress.phase === 'complete' &&
    !outcome.error
  )
    return { status: 'passed', phase: 'complete' };
  return {
    status: 'failed',
    phase: progress.phase,
    error: [
      outcome.error,
      progress.error,
      `Editor exited ${outcome.exitCode}; case ${progress.status}.`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export async function runCases(
  specs: CaseSpec[],
  metadata: Record<string, unknown>,
  execute: (spec: CaseSpec) => Outcome | Promise<Outcome>,
  save: (report: Report) => void | Promise<void>,
): Promise<Report> {
  if (!specs.length) throw new Error('No installed-extension cases discovered.');
  if (new Set(specs.map((row) => `${row.version}/${row.id}`)).size !== specs.length)
    throw new Error('Duplicate installed-extension case identifiers.');
  const cases: CaseResult[] = specs.map((row) => ({
    ...row,
    status: 'unexecuted',
    phase: 'launch',
    durationMs: 0,
  }));
  const report: Report = {
    metadata,
    conclusion: 'running',
    counts: {
      discovered: cases.length,
      executed: 0,
      passed: 0,
      failed: 0,
      unexecuted: cases.length,
    },
    cases,
  };
  async function persist() {
    report.counts = {
      discovered: cases.length,
      executed: cases.filter((row) => row.status !== 'unexecuted').length,
      passed: cases.filter((row) => row.status === 'passed').length,
      failed: cases.filter((row) => row.status === 'failed').length,
      unexecuted: cases.filter((row) => row.status === 'unexecuted').length,
    };
    await save(report);
  }
  await persist();
  for (const row of cases) {
    row.status = 'running';
    await persist();
    const start = Date.now();
    try {
      Object.assign(row, classify(row, await execute(row)));
    } catch (error) {
      Object.assign(row, { status: 'failed', phase: 'launch', error: describe(error) });
    }
    row.durationMs = Date.now() - start;
    await persist();
  }
  report.conclusion = cases.every((row) => row.status === 'passed') ? 'success' : 'failure';
  await persist();
  return report;
}

export function junit(report: Report): string {
  const xml = (value: unknown) =>
    String(value).replace(
      /[<>&"']/gu,
      (character) =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!,
    );
  // Incomplete cases are failures, never silent skips, in an interrupted run.
  const failures = report.cases.filter((row) => row.status !== 'passed').length;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="installed-vsix" tests="${report.cases.length}" failures="${failures}" skipped="0">\n` +
    report.cases
      .map(
        (row) =>
          `  <testcase classname="vscode.${xml(row.version)}" name="${xml(row.id)}" time="${row.durationMs / 1000}">` +
          (row.status === 'passed'
            ? ''
            : `<failure message="${xml(`${row.status}: ${row.phase}`)}">${xml(row.error ?? 'Case has not completed.')}</failure>`) +
          '</testcase>',
      )
      .join('\n') +
    '\n</testsuite>\n'
  );
}
