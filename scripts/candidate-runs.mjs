// API results are newest first. PR runs report the branch head as head_sha, but their
// checkout and artifact stamps use GitHub's temporary merge commit instead.
export function selectCandidateRun(runs, revision) {
  return runs.find(
    (run) =>
      run.head_sha === revision &&
      (run.event === 'push' || run.event === 'workflow_dispatch') &&
      run.conclusion !== 'cancelled',
  );
}
