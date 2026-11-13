// API results are newest first. PR runs report the branch head as head_sha, but their
// checkout and artifact stamps use GitHub's temporary merge commit instead.
/**
 * @template {{ head_sha?: string, event?: string, conclusion?: string | null }} Run
 * @param {readonly Run[]} runs
 * @param {string} revision
 */
export function selectCandidateRun(runs, revision) {
  return runs.find(
    (run) =>
      run.head_sha === revision &&
      (run.event === 'push' || run.event === 'workflow_dispatch') &&
      run.conclusion !== 'cancelled',
  );
}
