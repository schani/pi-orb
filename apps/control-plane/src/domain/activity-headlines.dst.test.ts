import type { HistoryRecord } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { ok, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import { generateActivityHeadline } from "./activity-headlines.ts";
import type { ActivityHeadlineGenerator } from "./ports.ts";

const ref = { orbId: "orb", sessionId: "session", recordId: "record", detailKey: "record:0" };
const record: HistoryRecord = {
  id: "record",
  parentId: null,
  overflow: {},
  timestamp: "2026-10-04T00:00:00Z",
  type: "message",
  role: "assistant",
  content: [
    {
      type: "tool_call",
      callId: "call",
      name: "codemode",
      arguments: { code: "Inspect configuration" },
    },
  ],
};
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness() {
  const h = makeHarness();
  h.store.seedProject(makeProjectRow("project"));
  h.store.seedOrb(makeOrbRow("orb", "project", "stopped"));
  return h;
}
async function replicate(task: SimulationTask, h: ReturnType<typeof harness>) {
  return h.store.commitPullBatch(task, {
    orbId: "orb",
    expectedCursor: null,
    session: { id: "session", overflow: {} },
    records: [record],
    nextCursor: "record",
    nextHeadId: "record",
  });
}

// Source/publication success isolate timing: the retained first traces demonstrate
// that default late scheduling can legitimately exhaust admission before inference.
describe("headline request lifetimes DST", () => {
  it("holds the same request until its missing source replicates", async () => {
    await runDst(
      { name: "headline-source-wait", iterations: 20, lateTimerProbability: 0 },
      async (sim) => {
        const h = harness();
        const missing = gate();
        let calls = 0;
        let reads = 0;
        const original = h.store.readHistoryRecord.bind(h.store);
        h.store.readHistoryRecord = (...args) => {
          if (reads++ === 0) {
            missing.resolve();
            return okAsync(null);
          }
          return original(...args);
        };
        const deps = {
          ...h.deps,
          headlineGenerator: {
            generate: () => {
              calls++;
              return okAsync("Inspect configuration");
            },
          },
        };
        const result = await sim.runTasks([
          {
            name: "request",
            f: async (task) => {
              const result = await generateActivityHeadline(task, deps, ref);
              expect(result.isOk()).toBe(true);
              return ok(undefined);
            },
          },
          {
            name: "replica",
            f: async (task) => {
              await missing.promise;
              await task.checkpoint("replicate observed missing source");
              return replicate(task, h);
            },
          },
        ]);
        expect(result.isOk()).toBe(true);
        expect(calls).toBe(1);
        expect(reads).toBeGreaterThan(1);
      },
    );
  });
  it("default late scheduling never starts new IO after actual expiry or cancellation", async () => {
    await runDst({ name: "headline-default-late-safety", iterations: 100 }, async (sim) => {
      const h = harness();
      const controller = new AbortController();
      const started = gate();
      const settled = gate();
      const release = gate();
      let admitted = 0;
      let inferenceStarted = false;
      let writes = 0;
      const outcomes = await sim.runTasks([
        {
          name: "request",
          f: async (task) => {
            await replicate(task, h);
            admitted = task.monotonicNow();
            const allowed = () => {
              expect(controller.signal.aborted).toBe(false);
              expect(task.monotonicNow()).toBeLessThan(admitted + 30_000);
            };
            const store = new Proxy(h.store, {
              get(target, key) {
                const value = Reflect.get(target, key);
                if (typeof value !== "function") return value;
                return (...args: unknown[]) => {
                  allowed();
                  if (key === "putActivityHeadlineIfAbsent") writes++;
                  return value.apply(target, args);
                };
              },
            });
            const generator: ActivityHeadlineGenerator = {
              generate: (providerTask) => {
                allowed();
                inferenceStarted = true;
                started.resolve();
                return new ResultAsync(
                  (async () => {
                    await release.promise;
                    await providerTask.sleep(30_001, "provider response beyond overall deadline");
                    return ok("Late candidate");
                  })(),
                );
              },
            };
            const result = await generateActivityHeadline(
              task,
              { ...h.deps, store, headlineGenerator: generator },
              ref,
              { signal: controller.signal },
            );
            expect(result.isErr()).toBe(true);
            expect(["cancelled", "unavailable"]).toContain(result._unsafeUnwrapErr().type);
            settled.resolve();
            return ok(undefined);
          },
        },
        {
          name: "disconnect",
          f: async (task) => {
            await Promise.race([started.promise, settled.promise]);
            await task.checkpoint("caller cancellation after inference or terminal outcome");
            if (inferenceStarted) controller.abort();
            release.resolve();
            return ok(undefined);
          },
        },
      ]);
      expect(outcomes.isOk(), outcomes.isErr() ? outcomes.error.message : "").toBe(true);
      expect(writes).toBe(0);
    });
  });
  it("missing source consumes one overall budget without inference under default late scheduling", async () => {
    await runDst({ name: "headline-source-expiry", iterations: 20 }, async (sim) => {
      const h = harness();
      let calls = 0;
      let reads = 0;
      const read = h.store.readHistoryRecord.bind(h.store);
      h.store.readHistoryRecord = (...args) => {
        reads++;
        return read(...args);
      };
      const outcomes = await sim.runTasks([
        {
          name: "request",
          f: async (task) => {
            const before = task.monotonicNow();
            const result = await generateActivityHeadline(
              task,
              {
                ...h.deps,
                headlineGenerator: {
                  generate: () => {
                    calls++;
                    return okAsync("Unused");
                  },
                },
              },
              ref,
            );
            expect(result._unsafeUnwrapErr()).toMatchObject({
              type: "unavailable",
              stage: "source",
            });
            expect(task.monotonicNow() - before).toBeGreaterThanOrEqual(30_000);
            return ok(undefined);
          },
        },
      ]);
      expect(outcomes.isOk()).toBe(true);
      expect(calls).toBe(0);
      expect(reads).toBeLessThanOrEqual(30);
    });
  });
  it("monotonic expiry blocks writes before a delayed deadline callback", async () => {
    await runDst({ name: "headline-late-deadline-callback", iterations: 20 }, async (sim) => {
      const h = harness();
      let writes = 0;
      const put = h.store.putActivityHeadlineIfAbsent.bind(h.store);
      h.store.putActivityHeadlineIfAbsent = (...args) => {
        writes++;
        return put(...args);
      };
      const outcomes = await sim.runTasks([
        {
          name: "late callback",
          f: async (task) => {
            await replicate(task, h);
            let offset = 0;
            const delayed = new Proxy(task, {
              get(target, key) {
                if (key === "monotonicNow") return () => target.monotonicNow() + offset;
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
            const generator: ActivityHeadlineGenerator = {
              generate: (_task, _input, context) => {
                expect(context.signal.aborted).toBe(false);
                offset = 30_001;
                return okAsync("Late candidate");
              },
            };
            const result = await generateActivityHeadline(
              delayed,
              { ...h.deps, headlineGenerator: generator },
              ref,
            );
            expect(result._unsafeUnwrapErr().type).toBe("unavailable");
            expect(writes).toBe(0);
            return ok(undefined);
          },
        },
      ]);
      expect(outcomes.isOk()).toBe(true);
    });
  });
  it.each(["deleting", "session"] as const)(
    "fences %s changes around inference under default late scheduling",
    async (change) => {
      await runDst({ name: `headline-fence-${change}`, iterations: 40 }, async (sim) => {
        const h = harness();
        const started = gate();
        const settled = gate();
        const changed = gate();
        let inferred = false;
        let writes = 0;
        const put = h.store.putActivityHeadlineIfAbsent.bind(h.store);
        h.store.putActivityHeadlineIfAbsent = (...args) => {
          writes++;
          return put(...args);
        };
        const generator: ActivityHeadlineGenerator = {
          generate: () =>
            new ResultAsync(
              (async () => {
                inferred = true;
                started.resolve();
                await changed.promise;
                return ok("Candidate");
              })(),
            ),
        };
        const outcomes = await sim.runTasks([
          {
            name: "request",
            f: async (task) => {
              await replicate(task, h);
              const result = await generateActivityHeadline(
                task,
                { ...h.deps, headlineGenerator: generator },
                ref,
              );
              expect(result.isErr()).toBe(true);
              expect([
                "unavailable",
                change === "deleting" ? "orb_missing" : "invalid_session",
              ]).toContain(result._unsafeUnwrapErr().type);
              settled.resolve();
              return ok(undefined);
            },
          },
          {
            name: "mutation",
            f: async (task) => {
              await Promise.race([started.promise, settled.promise]);
              await task.checkpoint("deletion/session change at inference gate");
              if (inferred) {
                const orb = h.store.orbSnapshot("orb")!;
                h.store.seedOrb(
                  change === "deleting"
                    ? { ...orb, state: "deleting" }
                    : { ...orb, harnessSessionId: "replacement" },
                );
              }
              changed.resolve();
              return ok(undefined);
            },
          },
        ]);
        expect(outcomes.isOk()).toBe(true);
        expect(writes).toBe(0);
      });
    },
  );
  it("an issued write may commit after cancellation but cannot publish a response", async () => {
    await runDst({ name: "headline-issued-write-cancel", iterations: 40 }, async (sim) => {
      const h = harness();
      const issued = gate();
      const settled = gate();
      const released = gate();
      const controller = new AbortController();
      let wrote = false;
      const put = h.store.putActivityHeadlineIfAbsent.bind(h.store);
      h.store.putActivityHeadlineIfAbsent = (task, candidate) =>
        new ResultAsync(
          (async () => {
            wrote = true;
            issued.resolve();
            await released.promise;
            return await put(task, candidate);
          })(),
        );
      const outcomes = await sim.runTasks([
        {
          name: "request",
          f: async (task) => {
            await replicate(task, h);
            const result = await generateActivityHeadline(task, h.deps, ref, {
              signal: controller.signal,
            });
            expect(["cancelled", "unavailable"]).toContain(result._unsafeUnwrapErr().type);
            settled.resolve();
            if (wrote)
              expect(
                (await h.store.readActivityHeadline(task, ref))._unsafeUnwrap()?.headline,
              ).toBeTruthy();
            return ok(undefined);
          },
        },
        {
          name: "cancel",
          f: async (task) => {
            await Promise.race([issued.promise, settled.promise]);
            await task.checkpoint("disconnect after write admission");
            if (wrote) controller.abort();
            released.resolve();
            return ok(undefined);
          },
        },
      ]);
      expect(outcomes.isOk(), outcomes.isErr() ? outcomes.error.message : "").toBe(true);
    });
  });
});

describe("headline concurrent publication DST", () => {
  it.each([0, 1])(
    "both independent requests return explicitly gated candidate %i winner",
    async (winner) => {
      await runDst(
        {
          name: `headline-independent-publication-${winner}`,
          iterations: 20,
          lateTimerProbability: 0,
        },
        async (sim) => {
          const h = harness();
          let calls = 0;
          const both = gate();
          const published = gate();
          const releases = [gate(), gate()];
          const values: unknown[] = [];
          const put = h.store.putActivityHeadlineIfAbsent.bind(h.store);
          h.store.putActivityHeadlineIfAbsent = (task, candidate) =>
            put(task, candidate).map((value) => {
              published.resolve();
              return value;
            });
          const deps = [0, 1].map((index) => ({
            ...h.deps,
            headlineGenerator: {
              generate: () =>
                new ResultAsync(
                  (async () => {
                    if (++calls === 2) both.resolve();
                    await releases[index]!.promise;
                    return ok(`Candidate ${index}`);
                  })(),
                ),
            },
          }));
          const seeded = await sim.runTasks([
            {
              name: "seed",
              f: async (task) => {
                await replicate(task, h);
                return ok(undefined);
              },
            },
          ]);
          expect(seeded.isOk()).toBe(true);
          const results = await sim.runTasks([
            ...deps.map((dep, i) => ({
              name: `request-${i}`,
              f: async (task: SimulationTask) => {
                const result = await generateActivityHeadline(task, dep, ref);
                expect(result._unsafeUnwrap().headline).toBe(`Candidate ${winner}`);
                values.push(result._unsafeUnwrap());
                return ok(undefined);
              },
            })),
            {
              name: "winner gate",
              f: async (task) => {
                await both.promise;
                await task.checkpoint("release selected winner inference");
                releases[winner]!.resolve();
                await published.promise;
                releases[1 - winner]!.resolve();
                return ok(undefined);
              },
            },
          ]);
          expect(results.isOk()).toBe(true);
          expect(calls).toBe(2);
          expect(values).toHaveLength(2);
          expect(values[0]).toEqual(values[1]);
        },
      );
    },
  );
});
