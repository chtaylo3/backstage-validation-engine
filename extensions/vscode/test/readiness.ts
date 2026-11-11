export async function until(
  check: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const end = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error('Timed out: ' + description);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
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
