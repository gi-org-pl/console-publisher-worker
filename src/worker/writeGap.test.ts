// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { clock } from "./writeGap";

describe("The pause between two writes to one R2 key", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends after the time it was given, not before", async () => {
    vi.useFakeTimers();
    let done = false;
    const pause = clock.sleep(1100).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1099);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pause;
    expect(done).toBe(true);
  });
});
