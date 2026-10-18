/**
 * R2 takes one write a second to the same key and answers 429 above that
 * (https://developers.cloudflare.com/r2/platform/limits/). A second write to
 * a key keeps this distance from the first.
 */
export const R2_WRITE_GAP_MS = 1_100;

/** Pauses without using CPU time; an object, so tests can replace it. */
export const clock = {
  sleep: (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/**
 * A second write to a key written at `firstWriteAt`: it waits out the rest of
 * the gap, and if R2 still refuses the write, tries once more a gap later.
 * `onRetry` hears the first failure.
 */
export async function writeAgain<T>(
  firstWriteAt: number,
  write: () => Promise<T>,
  onRetry: (cause: unknown) => void,
): Promise<T> {
  await clock.sleep(Math.max(0, R2_WRITE_GAP_MS - (Date.now() - firstWriteAt)));
  try {
    return await write();
  } catch (cause) {
    onRetry(cause);
    await clock.sleep(R2_WRITE_GAP_MS);
    return write();
  }
}
