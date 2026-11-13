/**
 * Runs `work` for indexes `0..count-1` on at most `concurrency` cooperative lanes. Each lane takes
 * the next unclaimed index; results keep index order whatever the completion order.
 *
 * When `work` rejects, no lane takes another index and `stopped()` turns true, so that work in
 * flight can stop before its next step. The lanes in flight are awaited; only then does the call
 * reject, with the first error thrown.
 */
export async function scheduleLanes<T>(
  count: number,
  concurrency: number,
  work: (index: number, stopped: () => boolean) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  let failure: { readonly error: unknown } | undefined;
  const stopped = () => failure !== undefined;
  const lane = async (): Promise<void> => {
    while (!failure && next < count) {
      const index = next++;
      try {
        results[index] = await work(index, stopped);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, lane));
  if (failure) throw failure.error;
  return results;
}
