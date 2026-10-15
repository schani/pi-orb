import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { readModelUsage } from "./usage-read.ts";

const task = new NoSimulationTask("usage read", false);
const boundaries = [0, 900000, 1800000];
it("reads only the selected owner and reconciles totals across grouped buckets", async () => {
  const read = vi.fn(() =>
    okAsync({
      buckets: [
        {
          at: 0,
          orbId: "a",
          use: "root" as const,
          provider: "p",
          model: "m",
          input: 10,
          output: 2,
          cacheRead: 80,
          cacheWrite: 10,
          calls: 2,
        },
        {
          at: 900000,
          orbId: "b",
          use: "subagent" as const,
          provider: "p",
          model: "m",
          input: 20,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          calls: 1,
        },
      ],
      orbs: [],
    }),
  );
  const result = (
    await readModelUsage(task, { read }, "owner", { boundaries: JSON.stringify(boundaries) })
  )._unsafeUnwrap();
  expect(read).toHaveBeenCalledWith(task, "owner", boundaries);
  expect(result.summary).toEqual({ input: 30, output: 7, cacheRead: 80, cacheWrite: 10, calls: 3 });
  expect(result.boundaries).toEqual(boundaries);
});
it("does not call storage for invalid queries; preserves typed read failures", async () => {
  const read = vi.fn(() =>
    errAsync({
      type: "store_error" as const,
      code: "unavailable" as const,
      message: "offline",
      retryable: true,
    }),
  );
  expect((await readModelUsage(task, { read }, "o", {}))._unsafeUnwrapErr().type).toBe(
    "usage_request_invalid",
  );
  expect(read).not.toHaveBeenCalled();
  expect(
    (
      await readModelUsage(task, { read }, "o", { boundaries: JSON.stringify(boundaries) })
    )._unsafeUnwrapErr(),
  ).toMatchObject({ code: "unavailable", message: "offline" });
});
