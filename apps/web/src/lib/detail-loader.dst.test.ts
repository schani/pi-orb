import type { LiveDisplayDetail } from "@pi-orb/protocol";
import type { Deadline, SimulationTask } from "determined";
import { err, ok, type Result } from "neverthrow";
import { afterEach, expect, it, vi } from "vitest";
import { runDst } from "../../../orb-runtime/src/testkit/sim.ts";
import { DetailLoader } from "./detail-loader.ts";

afterEach(() => vi.useRealTimers());

it("DST: open running detail polls once per second without overlapping; close and navigation fence late responses", async () => {
  vi.useFakeTimers();
  await runDst({ name: "lazy-detail-owner", iterations: 30 }, async (sim) => {
    const pending: Array<(result: Result<string, string>) => void> = [];
    const seen: string[] = [];
    let active = false;
    let opened!: () => void;
    const ready = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const loader = new DetailLoader<string>({
      read: () => new Promise((resolve) => pending.push(resolve)),
      publish: (result) => {
        expect(active).toBe(true);
        if (result.isOk()) seen.push(result.value);
      },
      intervalMs: 1000,
    });
    const result = await sim.runTasks([
      {
        name: "responses",
        f: async (task) => {
          await ready;
          await task.checkpoint("first response");
          const first = pending.shift();
          expect(first).toBeDefined();
          first?.(ok("old"));
          await Promise.resolve();
          await task.checkpoint("after navigation");
          const second = pending.shift();
          if (second !== undefined) second(ok("stale"));
          await Promise.resolve();
        },
      },
      {
        name: "owner",
        f: async (task) => {
          active = true;
          loader.open("a", true);
          opened();
          await task.checkpoint("close/reopen");
          active = false;
          loader.close();
          active = true;
          loader.open("a", true);
          await task.checkpoint("navigate");
          active = false;
          loader.close();
        },
      },
    ]);
    if (result.isErr()) throw result.error;
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("one in-flight read, retry after error, disconnect stops refresh and commit fences running response", async () => {
  vi.useFakeTimers();
  const pending: Array<(result: Result<string, string>) => void> = [];
  const read = vi.fn(() => new Promise<Result<string, string>>((resolve) => pending.push(resolve)));
  const publish = vi.fn();
  const loader = new DetailLoader<string>({ read, publish, intervalMs: 1000 });
  loader.open("live", true);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(1);
  pending.shift()?.(err("unavailable"));
  await Promise.resolve();
  expect(publish).toHaveBeenCalledWith(err("unavailable"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(1);
  loader.retry();
  expect(read).toHaveBeenCalledTimes(2);
  loader.open("committed", false);
  expect(read).toHaveBeenCalledTimes(3);
  pending.shift()?.(ok("late live"));
  pending.shift()?.(ok("final"));
  await Promise.resolve();
  expect(publish).toHaveBeenLastCalledWith(ok("final"));
  expect(publish).not.toHaveBeenCalledWith(ok("late live"));
  loader.connected(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(read).toHaveBeenCalledTimes(3);
  loader.close();
});

it("terminal live snapshot stops polling", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => ok({ state: "completed" }));
  const loader = new DetailLoader({
    read,
    publish: () => {},
    shouldContinue: (detail) => detail.state === "running",
  });
  loader.open("live", true);
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(4000);
  expect(read).toHaveBeenCalledTimes(1);
  loader.close();
});

it("coalesces pending reads across disclosure remounts sharing an active-view pool", async () => {
  const pending = new Map<string, Promise<Result<string, string>>>();
  let resolve!: (value: Result<string, string>) => void;
  const read = vi.fn(
    () =>
      new Promise<Result<string, string>>((done) => {
        resolve = done;
      }),
  );
  const previous = vi.fn();
  const current = vi.fn();
  const first = new DetailLoader({ read, publish: previous, pending });
  first.open("same", true);
  first.close();
  const second = new DetailLoader({ read, publish: current, pending });
  second.open("same", true);
  expect(read).toHaveBeenCalledTimes(1);
  resolve(ok("latest"));
  await Promise.resolve();
  expect(previous).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledWith(ok("latest"));
  second.close();
});

it("coalesces an unfinished read across close/reopen and disconnect/reconnect without accepting the old owner", async () => {
  vi.useFakeTimers();
  let resolve!: (result: Result<string, string>) => void;
  const read = vi.fn(
    () =>
      new Promise<Result<string, string>>((done) => {
        resolve = done;
      }),
  );
  const publish = vi.fn();
  const loader = new DetailLoader<string>({ read, publish });
  loader.open("same", true);
  loader.close();
  loader.open("same", true);
  loader.connected(false);
  loader.connected(true);
  expect(read).toHaveBeenCalledTimes(1);
  resolve(ok("current"));
  await Promise.resolve();
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledWith(ok("current"));
  loader.close();
});

it("DST: repeated retry before response retains one publisher and one closeable timer", async () => {
  vi.useFakeTimers();
  await runDst({ name: "detail-repeated-retry", iterations: 1 }, async (sim) => {
    vi.clearAllTimers();
    let resolve!: (result: Result<string, string>) => void;
    const read = vi.fn(
      () =>
        new Promise<Result<string, string>>((done) => {
          resolve = done;
        }),
    );
    const publish = vi.fn();
    const loader = new DetailLoader<string>({ read, publish });
    let retried!: () => void;
    const retriesDone = new Promise<void>((done) => {
      retried = done;
    });
    loader.open("same", true);
    const result = await sim.runTasks([
      {
        name: "retry",
        f: async (task) => {
          await task.checkpoint("first retry before response");
          loader.retry();
          await task.checkpoint("second retry before response");
          loader.retry();
          retried();
        },
      },
      {
        name: "response",
        f: async (task) => {
          await retriesDone;
          await task.checkpoint("resolve coalesced request");
          expect(read).toHaveBeenCalledTimes(1);
          resolve(ok("current"));
          await Promise.resolve();
          const published = publish.mock.calls.length;
          const timersBeforeClose = vi.getTimerCount();
          loader.close();
          expect({ published, timersBeforeClose, timersAfterClose: vi.getTimerCount() }).toEqual({
            published: 1,
            timersBeforeClose: 1,
            timersAfterClose: 0,
          });
          expect(publish).toHaveBeenCalledWith(ok("current"));
        },
      },
    ]);
    if (result.isErr()) throw result.error;
  });
});

it.each(["close", "disconnect", "reconnect", "open", "retry"] as const)(
  "DST: publish reentrancy via %s leaves polling with the current owner only",
  async (action) => {
    vi.useFakeTimers();
    await runDst({ name: `detail-publish-${action}`, iterations: 1 }, async (sim) => {
      vi.clearAllTimers();
      const pending: Array<(result: Result<string, string>) => void> = [];
      const read = vi.fn(() => new Promise<Result<string, string>>((done) => pending.push(done)));
      const publish = vi.fn((result: Result<string, string>) => {
        if (result.isErr() || result.value !== "first") return;
        switch (action) {
          case "close":
            loader.close();
            break;
          case "disconnect":
            loader.connected(false);
            break;
          case "reconnect":
            loader.connected(false);
            loader.connected(true);
            break;
          case "open":
            loader.open("next", true);
            break;
          case "retry":
            loader.retry();
            break;
        }
      });
      const loader = new DetailLoader<string>({ read, publish });
      loader.open("same", true);
      const result = await sim.runTasks([
        {
          name: "responses",
          f: async (task) => {
            await task.checkpoint("publish changes owner");
            pending.shift()?.(ok("first"));
            await Promise.resolve();
            const timersAfterPublish = vi.getTimerCount();
            const continues = action === "reconnect" || action === "open" || action === "retry";
            await task.checkpoint("current owner response");
            if (continues) pending.shift()?.(ok("current"));
            await Promise.resolve();
            const timersAfterCurrent = vi.getTimerCount();
            loader.close();
            expect({
              timersAfterPublish,
              timersAfterCurrent,
              timersAfterClose: vi.getTimerCount(),
              reads: read.mock.calls.length,
              publishes: publish.mock.calls.length,
            }).toEqual({
              timersAfterPublish: 0,
              timersAfterCurrent: continues ? 1 : 0,
              timersAfterClose: 0,
              reads: continues ? 2 : 1,
              publishes: continues ? 2 : 1,
            });
          },
        },
      ]);
      if (result.isErr()) throw result.error;
    });
  },
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const scope = "shared disclosure";
const identity = { sessionId: "session", operationId: "operation", blockId: "block" };
const sides = ["before", "after"] as const;
type Response = Result<LiveDisplayDetail, string>;

// Actual disclosures and scoped pool; only platform timers and HTTP completion are supplied.
function disclosures(task: SimulationTask) {
  const active = new Map<number, Deadline>();
  let serial = 0;
  vi.stubGlobal("setTimeout", (fire: () => void, delay: number) => {
    const id = ++serial;
    const deadline = task.createDeadline(delay, `detail timer ${id}`);
    active.set(id, deadline);
    deadline.signal.addEventListener("abort", () => {
      active.delete(id);
      deadline.cancel();
      fire(); // Deferred read only: no task API inside the abort listener.
    });
    return id;
  });
  vi.stubGlobal("clearTimeout", (id: number) => {
    active.get(id)?.cancel();
    active.delete(id);
  });
  const pending = new Map<string, Promise<Response>>();
  const requests: { key: string; response: ReturnType<typeof deferred<Response>> }[] = [];
  const read = (key: string) => {
    const response = deferred<Response>();
    requests.push({ key, response });
    return response.promise;
  };
  const seen = vi.fn<(result: Response) => void>();
  const peerSeen = vi.fn<(result: Response) => void>();
  const shouldContinue = (detail: LiveDisplayDetail) => detail.state === "running";
  const current = new DetailLoader({ read, pending, publish: seen, shouldContinue });
  const peer = new DetailLoader({ read, pending, publish: peerSeen, shouldContinue });
  const finish = async (
    index: number,
    state: LiveDisplayDetail["state"] | "error",
    coordinates = identity,
    text = `response-${index}`,
  ) => {
    const request = requests[index] ?? expect.fail("missing detail request");
    request.response.resolve(
      state === "error"
        ? err("network")
        : ok({
            v: 1,
            ...coordinates,
            state,
            body: { type: "reasoning", text },
          }),
    );
    await request.response.promise;
  };
  const dispose = () => {
    current.close();
    peer.close();
    for (const deadline of active.values()) deadline.cancel();
    vi.unstubAllGlobals();
  };
  return {
    current,
    peer,
    seen,
    peerSeen,
    requests,
    pending,
    finish,
    active,
    dispose,
    ready: deferred<void>(),
    done: deferred<void>(),
    order: [] as string[],
  };
}
type Disclosures = ReturnType<typeof disclosures>;
type Actor = (task: SimulationTask, views: Disclosures) => Promise<void>;

async function compose(name: string, ownership: Actor, response: Actor) {
  await runDst({ name, iterations: 1, timerOrder: "earliest" }, async (sim) => {
    const started = deferred<Disclosures>();
    let views: Disclosures | undefined;
    try {
      const result = await sim.runTasks([
        {
          name: "ownership",
          f: async (task) => {
            views = disclosures(task);
            started.resolve(views);
            await ownership(task, views);
          },
        },
        {
          name: "response",
          f: async (task) => {
            const views = await started.promise;
            await views.ready.promise;
            await response(task, views);
          },
        },
      ]);
      if (result.isErr()) throw result.error;
    } finally {
      views?.dispose();
    }
  });
}

it.each(
  sides.flatMap((side) =>
    (["completed", "error", "unavailable"] as const).map((terminal) => ({ side, terminal })),
  ),
)(
  "DST: shared retry response $side ownership deadline; $terminal stops polling",
  async ({ side, terminal }) => {
    await compose(
      `detail-shared-retry-${side}-${terminal}`,
      async (task, f) => {
        f.current.open(scope, true);
        f.peer.open(scope, true);
        f.current.retry();
        f.current.retry();
        expect(f.requests).toHaveLength(1);
        expect(f.pending.size).toBe(1);
        f.ready.resolve();
        await task.sleep(10, "peer ownership deadline");
        f.order.push("retire");
        f.peer.close();
        await f.done.promise;
        expect(f.seen).toHaveBeenCalledTimes(1);
        expect(f.peerSeen).toHaveBeenCalledTimes(side === "before" ? 1 : 0);
        expect(f.active.size).toBe(1);
        await task.sleep(1001, "current poll deadline");
        expect(f.requests).toHaveLength(2);
        expect(f.active.size).toBe(0);
        await f.finish(1, terminal);
        expect(f.seen).toHaveBeenCalledTimes(2);
        await task.sleep(2000, "terminal quiet");
        expect(f.requests).toHaveLength(2);
        expect(f.active.size).toBe(0);
        expect(f.pending.size).toBe(0);
        f.current.close();
        expect(f.active.size).toBe(0);
        expect(f.order).toEqual(
          side === "before" ? ["response", "retire"] : ["retire", "response"],
        );
      },
      async (task, f) => {
        await task.sleep(side === "before" ? 1 : 20, "response arrival");
        f.order.push("response");
        await f.finish(0, "running");
        f.done.resolve();
      },
    );
  },
);

it.each(
  sides.flatMap((side) =>
    (["close", "disconnect", "replace"] as const).map((action) => ({ side, action })),
  ),
)("DST: shared publication reenters $action ownership ($side)", async ({ action, side }) => {
  await compose(
    `detail-shared-reentry-${action}-${side}`,
    async (task, f) => {
      const next = "replacement disclosure";
      const nextIdentity = { ...identity, operationId: "next-operation" };
      const change = () => {
        if (action === "close") f.current.close();
        else if (action === "disconnect") f.current.connected(false);
        else f.current.open(next, true);
      };
      f.seen.mockImplementation((result) => {
        if (side === "after" && result.isOk() && f.seen.mock.calls.length === 1) {
          change(); // On the subscriber stack, not in the next scheduled actor.
        }
      });
      f.current.open(scope, true);
      f.peer.open(scope, true);
      expect(f.requests).toHaveLength(1);
      if (side === "before") change();
      f.ready.resolve();
      await f.done.promise;
      expect(f.active.size).toBeLessThanOrEqual(1);
      if (action === "replace") {
        expect(f.requests.map((read) => read.key)).toEqual([scope, next]);
        await f.finish(1, "running", nextIdentity, "replacement initial");
      }
      const previous = f.seen.mock.calls.slice();
      await task.sleep(1001, "remaining owners refresh");
      expect(f.requests.map((read) => read.key).sort()).toEqual(
        action === "replace" ? [scope, next, scope, next].sort() : [scope, scope],
      );
      const peerRead = f.requests.findIndex((read, i) => i > 0 && read.key === scope);
      await f.finish(peerRead, "completed", identity, "peer refresh");
      expect(f.peerSeen.mock.lastCall?.[0]).toMatchObject({
        value: { ...identity, body: { type: "reasoning", text: "peer refresh" } },
      });
      expect(f.seen.mock.calls).toEqual(previous);
      if (action === "replace") {
        const nextRead = f.requests.findIndex((read, i) => i > 1 && read.key === next);
        await f.finish(nextRead, "completed", nextIdentity, "replacement refresh");
        expect(f.seen.mock.lastCall?.[0]).toMatchObject({
          value: { ...nextIdentity, body: { type: "reasoning", text: "replacement refresh" } },
        });
      }
      await task.sleep(2000, "terminal and old owners quiet");
      expect(f.requests).toHaveLength(action === "replace" ? 4 : 2);
      expect(f.peerSeen).toHaveBeenCalledTimes(2);
      expect(f.seen).toHaveBeenCalledTimes(
        action === "replace" ? (side === "after" ? 3 : 2) : side === "after" ? 1 : 0,
      );
      expect(f.active.size).toBe(0);
      f.current.close();
      f.peer.close();
    },
    async (task, f) => {
      await task.checkpoint("shared publication");
      await f.finish(0, "running");
      f.done.resolve();
    },
  );
});
