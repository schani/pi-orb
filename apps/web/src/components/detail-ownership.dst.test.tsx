import type { CommittedDisplayDetail, LiveDisplayDetail } from "@pi-orb/protocol";
import type { Deadline } from "determined";
import { err, ok, type Result } from "neverthrow";
import { expect, it, vi } from "vitest";
import { runDst } from "../../../orb-runtime/src/testkit/sim.ts";
import { type ApiError, getCommittedDetail, getLiveDetail } from "../lib/api.ts";
import { DetailLoader } from "../lib/detail-loader.ts";
import { snapshotFromHistory, TranscriptCache } from "../lib/transcript-cache.ts";
import { history } from "../testkit/transcript.ts";
import { CommittedBody, type DetailContext, RunningBody } from "./DetailBody.tsx";

type Slot = { deps?: unknown[]; value?: unknown; cleanup?: (() => void) | undefined };
type Disclosure = {
  id: number;
  committed: boolean;
  slots: Slot[];
  context: DetailContext;
  active: boolean;
  epoch: number;
  scope?: string;
  loader?: DetailLoader<LiveDisplayDetail>;
  polling: boolean;
  readId?: number | undefined;
};
const hooks = vi.hoisted(() => ({
  cursor: 0,
  current: undefined as Disclosure | undefined,
  write: (_view: Disclosure, _value: unknown) => {},
  loader: (_view: Disclosure, _loader: DetailLoader<LiveDisplayDetail>) => {},
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const view = hooks.current ?? expect.fail("no rendering disclosure");
    const index = hooks.cursor++;
    view.slots[index] ??= { value: initial };
    const slot = view.slots[index];
    return [
      slot.value,
      (value: unknown) => {
        hooks.write(view, value);
        slot.value = value;
      },
    ];
  },
  useMemo: (make: () => unknown, deps: unknown[]) => {
    const view = hooks.current ?? expect.fail("no rendering disclosure");
    const index = hooks.cursor++;
    view.slots[index] ??= {};
    const slot = view.slots[index];
    if (!slot.deps || !deps.every((dep, i) => Object.is(dep, slot.deps?.[i]))) {
      slot.deps = deps;
      slot.value = make();
      hooks.loader(view, slot.value as DetailLoader<LiveDisplayDetail>);
    }
    return slot.value;
  },
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    const view = hooks.current ?? expect.fail("no rendering disclosure");
    const index = hooks.cursor++;
    view.slots[index] ??= {};
    const slot = view.slots[index];
    if (slot.deps && deps.every((dep, i) => Object.is(dep, slot.deps?.[i]))) return;
    slot.cleanup?.();
    view.epoch++;
    view.polling = false;
    view.readId = undefined;
    slot.deps = deps;
    slot.cleanup = effect();
  },
}));
vi.mock("../lib/api.ts", async (original) => ({
  ...(await original<typeof import("../lib/api.ts")>()),
  getLiveDetail: vi.fn(),
  getCommittedDetail: vi.fn(),
}));

type Read = {
  id: number;
  args: Parameters<typeof getLiveDetail>;
  done: boolean;
  scope: string;
  state?: string;
  finish: (result: Result<LiveDisplayDetail, ApiError>) => void;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["completed", "error", "unavailable"] as const)(
  "DST: RunningBody scoped pool, ownership and determined polling (%s)",
  async (terminal) => {
    const orders = new Set<string>();
    const coverage = {
      schedules: 0,
      timerCallbacks: 0,
      staleResponses: 0,
      publications: 0,
      retiredLiveResponses: 0,
      staleCacheResponses: 0,
      currentCachePublications: 0,
    };
    await runDst({ name: `detail-composition-${terminal}`, iterations: 80 }, async (sim) => {
      const cache = new TranscriptCache();
      let cacheOwner = cache.acquire("orb", "project");
      cacheOwner.publish(snapshotFromHistory(history("orb")));
      const cacheWrites = [vi.spyOn(cacheOwner, "publishDetail")];
      const livePending: DetailContext["livePending"] = new Map();
      const views: Disclosure[] = [];
      const reads: Read[] = [];
      const publications = new Set<string>();
      const order: string[] = [];
      let callbackFailure: unknown;
      const timers = new Map<number, { deadline: Deadline; view: Disclosure; fire: () => void }>();
      const fired: number[] = [];
      let publisher: Disclosure;
      let readingScope: string | undefined;
      let nextTimer = 0;
      let wake = () => {};
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let actors = 0;
      const firstFire = deferred<void>();
      const retiredLive = deferred<void>();
      const handoff = deferred<void>();
      const oldCacheDone = deferred<void>();
      const currentCacheDone = deferred<void>();
      const committedReads: ReturnType<
        typeof deferred<Result<CommittedDisplayDetail, ApiError>>
      >[] = [];
      let committedStarted = deferred<void>();
      vi.mocked(getCommittedDetail).mockImplementation(() => {
        const read = deferred<Result<CommittedDisplayDetail, ApiError>>();
        committedReads.push(read);
        committedStarted.resolve();
        return read.promise;
      });
      const openCommitted = async () => {
        committedStarted = deferred<void>();
        mount({ ...current.context, sessionId: "session", operationId: null }, true);
        await committedStarted.promise; // The production queueMicrotask has started HTTP.
      };
      const finishCommitted = async (index: number) => {
        const read = committedReads[index] ?? expect.fail("missing committed request");
        const detail: CommittedDisplayDetail = {
          v: 1,
          state: "committed",
          sessionId: "session",
          recordId: "one",
          detailKey: "one:0",
          body: { type: "reasoning", text: index === 0 ? "old" : "current" },
        };
        read.resolve(ok(detail));
        await read.promise;
        check();
      };
      let lateLive: Read;

      const mount = (context?: DetailContext, committed = false) => {
        const view: Disclosure = {
          id: views.length,
          committed,
          slots: [],
          active: true,
          epoch: 0,
          polling: false,
          context: context ?? {
            orbId: "orb",
            sessionId: "session",
            operationId: "operation",
            connected: true,
            cache,
            getOwner: () => cacheOwner,
            livePending,
            committedPending: new Map(),
            imagePending: new Map(),
          },
        };
        views.push(view);
        render(view);
        return view;
      };
      const render = (view: Disclosure) => {
        hooks.current = view;
        hooks.cursor = 0;
        if (view.committed)
          CommittedBody({ context: view.context, recordId: "one", detailKey: "one:0" });
        else RunningBody({ context: view.context, blockId: "reused" });
      };
      const close = (view: Disclosure) => {
        for (const slot of view.slots) slot.cleanup?.();
        view.active = false;
        view.polling = false;
      };
      const check = () => {
        if (callbackFailure !== undefined) throw callbackFailure;
        for (const read of reads.filter((read) => !read.done)) {
          expect(
            reads.filter(
              (other) => !other.done && other.args.every((arg, i) => arg === read.args[i]),
            ),
          ).toHaveLength(1);
        }
        for (const read of reads.filter((read) => !read.done)) {
          expect(reads.filter((other) => !other.done && other.scope === read.scope)).toHaveLength(
            1,
          );
        }
        for (const view of views) {
          const count = [...timers.values()].filter((timer) => timer.view === view).length;
          expect(count).toBeLessThanOrEqual(1);
          if (!view.active || !view.context.connected || !view.polling) expect(count).toBe(0);
        }
        expect(cache.getDetail("orb", "session", "one", "one:0")?.body).not.toEqual({
          type: "reasoning",
          text: "old",
        });
        expect(cache.getDetail("orb", "replacement", "one", "one:0")).toBeUndefined();
      };
      const subscribed = (view: Disclosure) => {
        view.readId =
          view.active && view.context.connected
            ? reads.findLast((read) => read.scope === view.scope)?.id
            : undefined;
      };
      hooks.loader = (view, loader) => {
        expect(loader).toBeInstanceOf(DetailLoader);
        view.loader = loader;
        const open = loader.open.bind(loader);
        vi.spyOn(loader, "open").mockImplementation((key, running) => {
          view.scope = key; // Observe the production key; do not reconstruct it.
          readingScope = key;
          open(key, running);
          subscribed(view);
        });
        const retry = loader.retry.bind(loader);
        vi.spyOn(loader, "retry").mockImplementation(() => {
          view.epoch++;
          view.polling = false;
          readingScope = view.scope;
          retry();
          subscribed(view);
        });
      };
      hooks.write = (view, value) => {
        publisher = view;
        try {
          if (value === null || value === undefined) return;
          if (view.committed) {
            expect(view.active).toBe(true);
            expect((value as { value?: unknown }).value).not.toEqual({
              type: "reasoning",
              text: "old",
            });
            return;
          }
          const publication = value as {
            scope: string;
            value?: LiveDisplayDetail["body"];
            message?: string;
          };
          expect(view.active && view.context.connected).toBe(true);
          expect(publication.scope).toBe(view.scope);
          const text =
            publication.value?.type === "reasoning" ? publication.value.text : publication.message;
          const id = Number(text?.match(/response-(\d+)/)?.[1]);
          // Unavailable has fixed UI copy; the settling read remains identifiable below.
          const read = Number.isNaN(id)
            ? reads.findLast((read) => read.scope === view.scope && read.state === "unavailable")
            : reads[id];
          expect(read).toBeDefined();
          expect(read?.args).toEqual([
            view.context.orbId,
            view.context.operationId,
            "reused",
            view.context.sessionId,
          ]);
          const token = `${view.id}/${view.epoch}/${read?.id}`;
          expect(publications.has(token)).toBe(false);
          publications.add(token);
          view.polling = publication.value !== undefined && read?.state === "running";
        } catch (error) {
          callbackFailure ??= error; // Report at a task boundary, not an unhandled .then rejection.
        }
      };
      vi.mocked(getLiveDetail).mockImplementation(
        (...args) =>
          new Promise((finish) => {
            const scope = readingScope;
            if (scope === undefined) callbackFailure ??= new Error("missing production scope");
            reads.push({
              id: reads.length,
              args,
              scope: scope ?? "missing",
              done: false,
              finish,
            });
          }),
      );
      const settle = async (read: Read, state: string) => {
        check();
        const recipients = views.filter(
          (view) => view.active && view.context.connected && view.readId === read.id,
        );
        const publishedRead = () =>
          [...publications].filter((token) => token.endsWith(`/${read.id}`)).length;
        const before = publishedRead();
        order.push(`response-${state}`);
        // Await the actual loader promises, including the API adapter's async mapErr.
        const request = livePending.get(read.scope);
        expect(request).toBeDefined();
        read.state = state;
        read.done = true;
        read.finish(
          state === "error"
            ? err({ type: "network", message: `response-${read.id}` })
            : ok({
                v: 1,
                sessionId: state === "wrong" ? "wrong-session" : read.args[3],
                operationId: read.args[1],
                blockId: read.args[2],
                state: state === "wrong" ? "completed" : (state as LiveDisplayDetail["state"]),
                body: { type: "reasoning", text: `response-${read.id}` },
              }),
        );
        // Only settled requests are awaited; other requests stay independently schedulable.
        await request;
        check();
        expect(publishedRead() - before).toBe(state === "wrong" ? 0 : recipients.length);
        if (!recipients.length) coverage.staleResponses++;
      };
      let current: Disclosure;
      const actor = (name: string, steps: number, act: (step: number) => Promise<void> | void) => ({
        name,
        f: async (task: import("determined").SimulationTask) => {
          await started;
          try {
            for (let step = 0; step < steps; step++) {
              await task.sleep(
                400 + Math.floor(task.random(`${name} delay`) * 900),
                `${name} ${step}`,
              );
              await task.checkpoint(name, step);
              order.push(`${name}-${step}`);
              await act(step);
              check();
            }
          } finally {
            actors++;
            wake();
          }
        },
      });
      try {
        const result = await sim.runTasks([
          {
            name: "platform-timer-worker",
            f: async (task) => {
              vi.stubGlobal("setTimeout", (fire: () => void, delay: number) => {
                const id = ++nextTimer;
                const deadline = task.createDeadline(delay, `disclosure timer ${id}`);
                timers.set(id, { deadline, view: publisher, fire });
                deadline.signal.addEventListener(
                  "abort",
                  () => {
                    fired.push(id);
                    if (id === 1) firstFire.resolve();
                    wake();
                  },
                  { once: true },
                );
                return id;
              });
              vi.stubGlobal("clearTimeout", (id: number) => {
                timers.get(id)?.deadline.cancel();
                timers.delete(id);
              });
              current = mount();
              mount();
              expect(reads).toHaveLength(1);
              await settle(reads[0] ?? expect.fail("missing initial request"), "running");
              expect(publications.size).toBe(2); // Two legitimate current subscribers.
              expect(timers.size).toBe(2);
              const dispatch = async () => {
                while (fired.length) {
                  const id = fired.shift() ?? expect.fail("missing fired timer");
                  await task.checkpoint("dispatch platform timer", id);
                  const timer = timers.get(id);
                  if (!timer) continue;
                  timers.delete(id);
                  timer.deadline.cancel();
                  order.push("poll");
                  coverage.timerCallbacks++;
                  readingScope = timer.view.scope;
                  timer.fire(); // Outside the abort listener: task APIs are safe here.
                  subscribed(timer.view);
                  check();
                }
              };
              await openCommitted();
              await firstFire.promise;
              await dispatch();
              lateLive = reads[1] ?? expect.fail("poll witness did not read");
              expect(coverage.timerCallbacks).toBeGreaterThan(0);
              ready();
              while (actors < 11) {
                if (!fired.length)
                  await new Promise<void>((resolve) => {
                    wake = resolve;
                  });
                await dispatch();
              }
              // Final owned terminal response proves polling stops without closing the disclosure.
              for (const view of views) if (view !== current) close(view);
              current.context.connected = true;
              render(current);
              current.loader?.retry();
              const final =
                reads.findLast(
                  (read) =>
                    !read.done &&
                    read.args[1] === current.context.operationId &&
                    read.args[3] === current.context.sessionId,
                ) ?? expect.fail("missing terminal request");
              await settle(final, terminal);
              const count = reads.length;
              await task.sleep(3000, "terminal quiet interval");
              expect(reads).toHaveLength(count);
              close(current);
              for (const read of reads.filter((read) => !read.done))
                await settle(read, "completed");
              const closedCount = reads.length;
              await task.sleep(3000, "closed quiet interval");
              expect(reads).toHaveLength(closedCount);
              expect(timers.size).toBe(0);
              expect(livePending.size).toBe(0);
              expect(reads.length).toBeLessThanOrEqual(24);
            },
          },
          actor("retry", 3, () => {
            current.polling = false;
            current.loader?.retry();
          }),
          actor("responses-success", 4, async () => {
            const read = reads.find((read) => !read.done && read !== lateLive);
            if (read) await settle(read, "running");
          }),
          actor("responses-error-identity", 4, async (step) => {
            const read = reads.findLast((read) => !read.done && read !== lateLive);
            if (read) await settle(read, step % 2 === 0 ? "error" : "wrong");
          }),
          actor("connection", 2, (step) => {
            current.context.connected = step === 1;
            if (current.active) render(current);
          }),
          actor("disclosure", 2, (step) => {
            if (step === 0) {
              close(current);
              retiredLive.resolve();
            } else current = mount({ ...current.context });
          }),
          actor("operation", 1, () => {
            current.context = { ...current.context, operationId: "replacement-operation" };
            if (current.active) render(current);
          }),
          actor("session", 1, () => {
            current.context = { ...current.context, sessionId: "replacement" };
            if (current.active) render(current);
          }),
          actor("late-live", 1, async () => {
            await retiredLive.promise;
            await settle(lateLive, "running");
            expect(views[0]?.active).toBe(false);
            coverage.retiredLiveResponses++;
          }),
          actor("cache-handoff", 1, async () => {
            cacheOwner.release();
            if (terminal === "error") cache.invalidate("orb");
            cacheOwner = cache.acquire("orb", "project");
            cacheWrites.push(vi.spyOn(cacheOwner, "publishDetail"));
            cacheOwner.publish(snapshotFromHistory(history("orb")));
            await openCommitted();
            expect(committedReads).toHaveLength(2);
            handoff.resolve();
          }),
          actor("old-committed-response", 1, async () => {
            await handoff.promise;
            if (terminal === "error") await currentCacheDone.promise;
            await finishCommitted(0);
            if (terminal === "error") expect(cacheWrites[0]).not.toHaveBeenCalled();
            else expect(cacheWrites[0]?.mock.results[0]?.value).toBe("stale");
            coverage.staleCacheResponses++;
            oldCacheDone.resolve();
          }),
          actor("current-committed-response", 1, async () => {
            await handoff.promise;
            if (terminal !== "error") await oldCacheDone.promise;
            await finishCommitted(1);
            expect(cacheWrites[1]?.mock.results[0]?.value).toBe("stored");
            expect(cache.getDetail("orb", "session", "one", "one:0")?.body).toEqual({
              type: "reasoning",
              text: "current",
            });
            coverage.currentCachePublications++;
            currentCacheDone.resolve();
          }),
        ]);
        if (result.isErr()) throw result.error;
        orders.add(order.join(","));
        coverage.schedules++;
        coverage.publications += publications.size;
      } finally {
        for (const view of views) close(view);
        for (const timer of timers.values()) timer.deadline.cancel();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.mocked(getLiveDetail).mockReset();
        vi.mocked(getCommittedDetail).mockReset();
        hooks.current = undefined;
        hooks.write = () => {};
        hooks.loader = () => {};
        cacheOwner.release();
      }
    });
    // Pinned witnesses, not probabilistic assertions about any one mixed interleaving.
    const schedules = process.env["DST_REPLAY"] ? 1 : 80;
    expect(coverage.schedules).toBe(schedules);
    expect(coverage.timerCallbacks).toBeGreaterThanOrEqual(schedules);
    expect(coverage.retiredLiveResponses).toBe(schedules);
    expect(coverage.staleCacheResponses).toBe(schedules);
    expect(coverage.currentCachePublications).toBe(schedules);
    console.info("detail composition coverage", {
      terminal,
      ...coverage,
      distinctOrders: orders.size,
    });
  },
);
