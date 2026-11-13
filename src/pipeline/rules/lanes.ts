/**
 * Runs `work` for indexes `0..count-1` on at most `concurrency` cooperative lanes. Each lane takes
 * the next unclaimed index; results keep index order whatever the completion order.
 */
export async function scheduleLanes<T>(
  count: number,
  concurrency: number,
  work: (index: number) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < count) {
      const index = next++;
      results[index] = await work(index);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, lane));
  return results;
}
