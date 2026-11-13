export const OBSERVATION_TIMEOUT_MS = 60_000;
export async function until(
  check: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const work = async () => {
    while (!stopped) {
      if (await check()) return;
      if (!stopped)
        await new Promise<void>((resolve) => {
          wake = resolve;
          pollTimer = setTimeout(resolve, 30);
        });
    }
  };
  try {
    // One deadline covers pending checks and all retry time. Promise.race keeps
    // a rejection observer on late provider work after the caller times out.
    await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out: ' + description)),
          OBSERVATION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(pollTimer);
    wake?.();
  }
}

/** A cancelled read is not an empty provider result or a successful absence check. */
export async function readProvider<T>(
  request: () => PromiseLike<T>,
  description: string,
  cancelled: () => void,
): Promise<T> {
  let result!: T;
  await until(async () => {
    try {
      result = await request();
      return true;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'Canceled') throw error;
      cancelled();
      return false;
    }
  }, description);
  return result;
}
