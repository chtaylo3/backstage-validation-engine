/**
 * Settles with `work`, or rejects with `timeout()` once `ms` real milliseconds pass first. A zero or
 * negative `ms` waits one timer turn. The timer is cleared on every outcome, so no handle outlives
 * the race. `timeout` runs only when the limit wins; callers name the rejection they need.
 */
export async function bounded<T>(work: Promise<T>, ms: number, timeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeout()), Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
