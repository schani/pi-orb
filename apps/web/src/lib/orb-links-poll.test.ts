import { afterEach, describe, expect, it, vi } from "vitest";
import { pollVisible } from "./orb-links-poll.ts";

function harness(visible = true) {
  const document = Object.assign(new EventTarget(), {
    visibilityState: visible ? "visible" : "hidden",
  });
  const pending: { signal: AbortSignal; resolve: (value: number) => void }[] = [];
  const read = vi.fn(
    (signal: AbortSignal) => new Promise<number>((resolve) => pending.push({ signal, resolve })),
  );
  const receive = vi.fn();
  const stop = pollVisible(read, receive, document);
  const visibility = (state: string) => {
    document.visibilityState = state;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  return { read, receive, pending, stop, visibility };
}

afterEach(() => vi.useRealTimers());

describe("orb links polling", () => {
  it("waits for completion before scheduling another request", async () => {
    vi.useFakeTimers();
    const h = harness();
    expect(h.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.read).toHaveBeenCalledTimes(1);
    h.pending[0]?.resolve(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.receive).toHaveBeenCalledWith(1);
    expect(h.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.read).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("does not start while hidden and resumes immediately without overlap", async () => {
    vi.useFakeTimers();
    const h = harness(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.read).not.toHaveBeenCalled();
    h.visibility("visible");
    expect(h.read).toHaveBeenCalledTimes(1);
    h.visibility("hidden");
    h.visibility("visible");
    expect(h.read).toHaveBeenCalledTimes(1);
    h.pending[0]?.resolve(1);
    await vi.advanceTimersByTimeAsync(0);
    h.visibility("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.read).toHaveBeenCalledTimes(1);
    h.visibility("visible");
    expect(h.read).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("aborts on collapse/unmount and rejects stale completions after another owner starts", async () => {
    vi.useFakeTimers();
    const old = harness();
    old.stop();
    expect(old.pending[0]?.signal.aborted).toBe(true);
    const next = harness();
    old.pending[0]?.resolve(1);
    next.pending[0]?.resolve(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(old.receive).not.toHaveBeenCalled();
    expect(next.receive).toHaveBeenCalledWith(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(old.read).toHaveBeenCalledTimes(1);
    expect(next.read).toHaveBeenCalledTimes(2);
    next.stop();
    next.visibility("visible");
    expect(next.read).toHaveBeenCalledTimes(2);
  });

  it("does not restart after an in-flight request completes in a hidden tab", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.visibility("hidden");
    h.pending[0]?.resolve(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.read).toHaveBeenCalledTimes(1);
    h.visibility("visible");
    expect(h.read).toHaveBeenCalledTimes(2);
    h.stop();
  });
});
