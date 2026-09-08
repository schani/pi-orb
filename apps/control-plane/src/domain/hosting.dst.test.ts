import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import { makeHostingHarness, openHostedFile, source } from "../testkit/hosting.ts";
import { runDst } from "../testkit/sim.ts";
import {
  cleanupHostedFiles,
  cleanupRetiredHostedFiles,
  publishHostedFile,
  removeHostedFile,
} from "./hosting.ts";

const task = new NoSimulationTask("hosting assertions", false);
const context = { signal: new AbortController().signal };

describe("hosted files domain", () => {
  it("accepts 32 MiB metadata and rejects the next byte before reading", async () => {
    const h = makeHostingHarness();
    const boundarySource = source("alpha");
    const boundary = await publishHostedFile(
      task,
      h.deps,
      { ...h.request("request-a"), size: 32 * 1024 * 1024 },
      boundarySource,
      context,
    );
    expect(boundary.isErr() && boundary.error.type).not.toBe("hosting_too_large");

    const oversizedSource = source("alpha");
    const oversized = await publishHostedFile(
      task,
      h.deps,
      { ...h.request("request-b"), size: 32 * 1024 * 1024 + 1 },
      oversizedSource,
      context,
    );
    expect(oversized.isErr() && oversized.error.type).toBe("hosting_too_large");
    expect(oversizedSource.pulled()).toBe(0);
  });

  it.each([
    FAILPOINTS.hostingSessionBegin,
    FAILPOINTS.hostingSessionRegisterBefore,
    FAILPOINTS.hostingSessionRegisterAfter,
    FAILPOINTS.hostingChunk,
    FAILPOINTS.hostingProviderFinalize,
    FAILPOINTS.hostingPublishBefore,
    FAILPOINTS.hostingPublishAfter,
  ])("replays after forced %s failure", async (failpoint) => {
    const probabilities: Record<string, number> = { [failpoint]: 1 };
    await runDst(
      {
        name: `hosting-forced-${failpoint.replaceAll(".", "-")}`,
        iterations: 1,
        failpointProbabilities: probabilities,
      },
      async (sim) => {
        const h = makeHostingHarness({ uploadLeaseMs: 1 });
        const result = await sim.runTasks([
          {
            name: "failed-then-restarted-uploader",
            f: async (innerTask) => {
              await publishHostedFile(
                innerTask,
                h.deps,
                h.request("request-a"),
                source("alpha"),
                context,
              );
              h.assertOwnership();
              probabilities[failpoint] = 0;
              await innerTask.sleep(1, "restart upload owner after forced failure");
              const replayed = await publishHostedFile(
                innerTask,
                h.deps,
                h.request("request-a"),
                source("alpha"),
                context,
              );
              expect(replayed.isOk()).toBe(true);
              h.assertOwnership();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(h.current("index.html")?.sha256).toBe(h.request("request-a").sha256);
      },
    );
  });

  it("recovers a publication whose committed response was lost", async () => {
    await runDst(
      {
        name: "hosting-publish-response-loss",
        iterations: 1,
        failpointProbabilities: { [FAILPOINTS.hostingPublishAfter]: 1 },
      },
      async (sim) => {
        const h = makeHostingHarness({ uploadLeaseMs: 500 });
        const result = await sim.runTasks([
          {
            name: "uploader",
            f: async (innerTask) => {
              const uploaded = await publishHostedFile(
                innerTask,
                h.deps,
                h.request("request-a"),
                source("alpha"),
                context,
              );
              expect(uploaded.isErr()).toBe(true);
              const visible = await h.deps.store.resolveFile(innerTask, h.orbId, "index.html");
              expect(visible.isOk() && visible.value?.sha256).toBe(h.request("request-a").sha256);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
  });

  it("converges across upload protocol failures without duplicate ownership", async () => {
    const initialProbabilities: Record<string, number> = {
      [FAILPOINTS.hostingSessionBegin]: 0.08,
      [FAILPOINTS.hostingSessionRegisterBefore]: 0.08,
      [FAILPOINTS.hostingSessionRegisterAfter]: 0.08,
      [FAILPOINTS.hostingChunk]: 0.08,
      [FAILPOINTS.hostingProviderFinalize]: 0.08,
      [FAILPOINTS.hostingPublishBefore]: 0.08,
      [FAILPOINTS.hostingPublishAfter]: 0.08,
      [FAILPOINTS.hostingCancel]: 0.05,
    };
    const probabilities = { ...initialProbabilities };
    await runDst(
      {
        name: "hosting-upload-failure-recovery",
        iterations: 30,
        failpointProbabilities: probabilities,
      },
      async (sim) => {
        Object.assign(probabilities, initialProbabilities);
        const h = makeHostingHarness({ uploadLeaseMs: 500 });
        const result = await sim.runTasks([
          {
            name: "retrying-uploader",
            f: async (innerTask) => {
              for (let attempt = 0; attempt < 100; attempt++) {
                const uploaded = await publishHostedFile(
                  innerTask,
                  h.deps,
                  h.request("request-a"),
                  source("alpha"),
                  context,
                );
                h.assertOwnership();
                if (uploaded.isOk()) return;
                await innerTask.sleep(500, "retry hosted upload");
              }
              for (const name of Object.keys(probabilities)) probabilities[name] = 0;
              const drained = await publishHostedFile(
                innerTask,
                h.deps,
                h.request("request-a"),
                source("alpha"),
                context,
              );
              expect(drained.isOk()).toBe(true);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(h.current("index.html")?.sha256).toBe(h.request("request-a").sha256);
        expect(h.dataCapableSessions()).toBe(0);
        h.assertOwnership();
      },
    );
  });

  it("replays cleanup after its durable acknowledgment is lost", async () => {
    const probabilities: Record<string, number> = {
      [FAILPOINTS.hostingCleanupFinishAfter]: 1,
    };
    await runDst(
      {
        name: "hosting-cleanup-ack-loss",
        iterations: 1,
        failpointProbabilities: probabilities,
      },
      async (sim) => {
        const h = makeHostingHarness();
        const result = await sim.runTasks([
          {
            name: "cleaner",
            f: async (innerTask) => {
              await publishHostedFile(
                innerTask,
                h.deps,
                h.request("request-a"),
                source("alpha"),
                context,
              );
              await publishHostedFile(
                innerTask,
                h.deps,
                h.request("request-b"),
                source("bravo"),
                context,
              );
              const cleaned = await cleanupRetiredHostedFiles(
                innerTask,
                h.deps,
                { leaseMs: 1_000, limit: 10 },
                context,
              );
              expect(cleaned.isErr()).toBe(true);
              expect(h.ownedObjects()).toHaveLength(1);
              probabilities[FAILPOINTS.hostingCleanupFinishAfter] = 0;
              const recovered = await cleanupRetiredHostedFiles(
                innerTask,
                h.deps,
                { leaseMs: 1_000, limit: 10 },
                context,
              );
              expect(recovered.isOk() && recovered.value).toBe(0);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
  });

  it("rejects stale attempt epochs", async () => {
    await runDst({ name: "hosting-stale-attempt-epoch", iterations: 4 }, async (sim) => {
      const h = makeHostingHarness();
      const result = await sim.runTasks([
        {
          name: "writer",
          f: async (innerTask) => {
            const reserved = await h.deps.store.reserveUpload(innerTask, h.request("request-a"));
            expect(reserved.isOk()).toBe(true);
            if (reserved.isErr()) return;
            const claimed = await h.deps.store.claimUpload(innerTask, {
              operationId: reserved.value.id,
              now: 0,
              leaseUntil: 100,
            });
            expect(claimed.isOk() && claimed.value.type).toBe("claimed");
            if (claimed.isErr() || claimed.value.type !== "claimed") return;
            const stale = await h.deps.store.registerSession(
              innerTask,
              claimed.value.attempt.id,
              claimed.value.attempt.epoch + 1,
              "session",
            );
            expect(stale.isErr()).toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("never exposes another orb namespace", async () => {
    await runDst({ name: "hosting-cross-namespace", iterations: 4 }, async (sim) => {
      const h = makeHostingHarness();
      const result = await sim.runTasks([
        {
          name: "reader",
          f: async (innerTask) => {
            await publishHostedFile(
              innerTask,
              h.deps,
              h.request("request-a"),
              source("alpha"),
              context,
            );
            expect((await h.deps.store.listFiles(innerTask, "other-orb"))._unsafeUnwrap()).toEqual(
              [],
            );
            expect(
              (
                await h.deps.store.resolveFile(innerTask, "other-orb", "index.html")
              )._unsafeUnwrap(),
            ).toBeNull();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("does not reserve or pull when the caller is already cancelled", async () => {
    const h = makeHostingHarness();
    const controller = new AbortController();
    controller.abort();
    const input = source("alpha");
    const result = await publishHostedFile(task, h.deps, h.request("request-a"), input, {
      signal: controller.signal,
    });
    expect(result.isErr() && result.error.type).toBe("hosting_cancelled");
    expect(input.pulled()).toBe(0);
    expect(input.closed()).toBe(1);
  });

  it("rejects a stream whose bytes do not match the declared digest", async () => {
    await runDst({ name: "hosting-declared-digest", iterations: 8 }, async (sim) => {
      const h = makeHostingHarness();
      const result = await sim.runTasks([
        {
          name: "uploader",
          f: async (task) => {
            const uploaded = await publishHostedFile(
              task,
              h.deps,
              h.request("request-a"),
              source("bravo"),
              context,
            );
            expect(uploaded.isErr()).toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("does not publish when the source fails after its last data chunk", async () => {
    const h = makeHostingHarness();
    let step = 0;
    let closes = 0;
    const uploaded = await publishHostedFile(
      task,
      h.deps,
      h.request("request-a"),
      {
        next: () =>
          step++ === 0
            ? okAsync(new TextEncoder().encode("alpha"))
            : errAsync({ type: "hosting_retryable" as const, message: "source failed" }),
        close: () => {
          closes++;
          return okAsync(undefined);
        },
      },
      context,
    );
    expect(uploaded.isErr()).toBe(true);
    expect(closes).toBe(1);
    expect(h.current("index.html")).toBeUndefined();
  });

  it("replays one request without replacing a later publication", async () => {
    await runDst({ name: "hosting-replay-after-replacement", iterations: 30 }, async (sim) => {
      const h = makeHostingHarness();
      const raced = await sim.runTasks([
        {
          name: "publisher-a",
          f: async (t) => {
            await publishHostedFile(t, h.deps, h.request("request-a"), source("alpha"), context);
          },
        },
        {
          name: "publisher-b",
          f: async (t) => {
            await publishHostedFile(t, h.deps, h.request("request-b"), source("bravo"), context);
          },
        },
      ]);
      expect(raced.isOk(), raced.isErr() ? raced.error.message : "").toBe(true);
      const before = h.current("index.html")?.object;
      const replay = await publishHostedFile(
        task,
        h.deps,
        h.request("request-a"),
        source("alpha"),
        context,
      );
      expect(replay.isOk()).toBe(true);
      expect(h.current("index.html")?.object).toEqual(before);
      h.assertOwnership();
    });
  });

  it("keeps reader snapshots exact while two uploads replace one path", async () => {
    await runDst({ name: "hosting-two-replacements-reader", iterations: 30 }, async (sim) => {
      const h = makeHostingHarness();
      let writersDone = 0;
      const result = await sim.runTasks([
        {
          name: "alpha-writer",
          f: async (innerTask) => {
            await publishHostedFile(
              innerTask,
              h.deps,
              h.request("request-a"),
              source("alpha"),
              context,
            );
            writersDone++;
          },
        },
        {
          name: "bravo-writer",
          f: async (innerTask) => {
            await publishHostedFile(
              innerTask,
              h.deps,
              h.request("request-b"),
              source("bravo"),
              context,
            );
            writersDone++;
          },
        },
        {
          name: "reader",
          f: async (innerTask) => {
            while (writersDone < 2) {
              const opened = await openHostedFile(
                innerTask,
                h.deps,
                h.orbId,
                "index.html",
                context,
              );
              if (opened.isOk()) {
                const chunk = await opened.value.source.next(innerTask, context);
                expect(chunk.isOk()).toBe(true);
                if (chunk.isOk() && chunk.value !== null) {
                  const text = new TextDecoder().decode(chunk.value);
                  expect(["alpha", "bravo"]).toContain(text);
                  expect(opened.value.file.sha256).toBe(
                    h.request(text === "alpha" ? "request-a" : "request-b").sha256,
                  );
                }
                await opened.value.source.close(innerTask);
              }
              await innerTask.checkpoint("reader between replacement snapshots");
            }
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      h.assertOwnership();
    });
  });

  it("gives concurrent retries one data-capable attempt", async () => {
    await runDst({ name: "hosting-concurrent-same-request", iterations: 30 }, async (sim) => {
      const h = makeHostingHarness();
      const outcomes: string[] = [];
      const raced = await sim.runTasks(
        ["a", "b"].map((name) => ({
          name,
          f: async (t: Parameters<typeof publishHostedFile>[0]) => {
            const result = await publishHostedFile(
              t,
              h.deps,
              h.request("request-a"),
              source("alpha"),
              context,
            );
            outcomes.push(result.isOk() ? "ok" : result.error.type);
          },
        })),
      );
      expect(raced.isOk(), raced.isErr() ? raced.error.message : "").toBe(true);
      expect(outcomes).toContain("ok");
      expect(h.dataCapableSessions()).toBe(0);
      h.assertOwnership();
    });
  });

  it("persists a session before consuming the first byte", async () => {
    const h = makeHostingHarness({ failSessionRegistration: true });
    const input = source("alpha");
    const result = await publishHostedFile(task, h.deps, h.request("request-a"), input, context);
    expect(result.isErr()).toBe(true);
    expect(input.pulled()).toBe(0);
    expect(h.dataCapableSessions()).toBe(0);
  });

  it("leaves a lost-begin session empty and retries with a fresh attempt", async () => {
    const h = makeHostingHarness();
    h.loseNextBegin();
    const first = source("alpha");
    const lost = await publishHostedFile(task, h.deps, h.request("request-a"), first, context);
    expect(lost.isErr()).toBe(true);
    expect(first.pulled()).toBe(0);
    expect(h.dataCapableSessions()).toBe(0);
    const replay = await publishHostedFile(
      task,
      h.deps,
      h.request("request-a"),
      source("alpha"),
      context,
    );
    expect(replay.isOk()).toBe(true);
    h.assertOwnership();
  });

  it("rechecks lifecycle authority after provider completion", async () => {
    await runDst({ name: "hosting-archive-before-publish", iterations: 12 }, async (sim) => {
      const h = makeHostingHarness();
      const bytes = source("alpha");
      let fenced = false;
      const result = await sim.runTasks([
        {
          name: "uploader",
          f: async (t) => {
            const uploaded = await publishHostedFile(
              t,
              h.deps,
              h.request("request-a"),
              {
                next: (innerTask, innerContext) => {
                  if (!fenced) {
                    fenced = true;
                    h.setLifecycle("archiving");
                  }
                  return bytes.next(innerTask, innerContext);
                },
                close: (innerTask) => bytes.close(innerTask),
              },
              context,
            );
            expect(uploaded.isErr()).toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(h.current("index.html")).toBeUndefined();
    });
  });

  it("fences removal by runtime incarnation", async () => {
    const h = makeHostingHarness();
    await publishHostedFile(task, h.deps, h.request("request-a"), source("alpha"), context);
    const removed = await removeHostedFile(
      task,
      h.deps,
      { orbId: h.orbId, runtimeTokenHash: "token", incarnation: 0 },
      "index.html",
    );
    expect(removed.isErr()).toBe(true);
    expect(h.current("index.html")).toBeDefined();
  });

  it("cancels known sessions before deletion reports complete", async () => {
    const h = makeHostingHarness();
    h.seedInterruptedUpload();
    const cleaned = await cleanupHostedFiles(task, h.deps, h.orbId, context);
    expect(cleaned.isOk()).toBe(true);
    expect(h.dataCapableSessions()).toBe(0);
    expect(h.ownedObjects()).toEqual([]);
  });

  it("adopts and deletes completion that wins cancellation", async () => {
    const h = makeHostingHarness();
    h.seedCompletedUpload();
    const cleaned = await cleanupHostedFiles(task, h.deps, h.orbId, context);
    expect(cleaned.isOk()).toBe(true);
    expect(h.ownedObjects()).toEqual([]);
    expect(h.events()).toContain(`cleanup_object:${h.orbId}/attempts/completed@late-generation`);
  });

  it("cancels a stale writer before restarting its upload", async () => {
    const h = makeHostingHarness();
    h.seedInterruptedUpload();
    const replayed = await publishHostedFile(
      task,
      h.deps,
      h.request("interrupted"),
      source("alpha"),
      context,
    );
    expect(replayed.isOk()).toBe(true);
    expect(h.dataCapableSessions()).toBe(0);
    h.assertOwnership();
  });

  it("adopts late provider completion after the prior worker disappears", async () => {
    const h = makeHostingHarness();
    h.seedCompletedUpload();
    const input = source("alpha");
    const replayed = await publishHostedFile(task, h.deps, h.request("completed"), input, context);
    expect(replayed.isOk()).toBe(true);
    expect(input.pulled()).toBe(0);
    expect(input.closed()).toBe(1);
    h.assertOwnership();
  });

  it("removal retires only the exact observed generation", async () => {
    const h = makeHostingHarness();
    await publishHostedFile(task, h.deps, h.request("request-a"), source("alpha"), context);
    const observed = h.current("index.html");
    await publishHostedFile(task, h.deps, h.request("request-b"), source("bravo"), context);
    const removed = await removeHostedFile(
      task,
      h.deps,
      { orbId: h.orbId, runtimeTokenHash: "token", incarnation: 1 },
      "index.html",
      observed?.object,
    );
    expect(removed.isOk()).toBe(true);
    expect(h.current("index.html")?.sha256).toBe(h.request("request-b").sha256);
    h.assertOwnership();
  });

  it("collects a replaced generation while retaining the current file", async () => {
    const h = makeHostingHarness();
    await publishHostedFile(task, h.deps, h.request("request-a"), source("alpha"), context);
    await publishHostedFile(task, h.deps, h.request("request-b"), source("bravo"), context);
    const current = h.current("index.html")?.object;
    const cleaned = await cleanupRetiredHostedFiles(
      task,
      h.deps,
      { leaseMs: 1000, limit: 10 },
      context,
    );
    expect(cleaned.isOk()).toBe(true);
    expect(h.ownedObjects()).toEqual([`${current?.key}@${current?.generation}`]);
    h.assertOwnership();
  });

  it("opens one exact generation across replacement", async () => {
    const h = makeHostingHarness();
    await publishHostedFile(task, h.deps, h.request("request-a"), source("alpha"), context);
    const opened = await openHostedFile(task, h.deps, h.orbId, "index.html", context);
    expect(opened.isOk()).toBe(true);
    const ref = opened.isOk() ? opened.value.file.object : undefined;
    await publishHostedFile(task, h.deps, h.request("request-b"), source("bravo"), context);
    expect(opened.isOk() ? opened.value.file.object : undefined).toEqual(ref);
    expect(h.current("index.html")?.object).not.toEqual(ref);
    if (opened.isOk()) await opened.value.source.close(task);
  });

  it("never returns truncated success when deletion races an open reader", async () => {
    await runDst({ name: "hosting-reader-delete-race", iterations: 20 }, async (sim) => {
      const h = makeHostingHarness();
      const result = await sim.runTasks([
        {
          name: "reader-and-remover",
          f: async (innerTask) => {
            await publishHostedFile(
              innerTask,
              h.deps,
              h.request("request-a"),
              source("alpha"),
              context,
            );
            const opened = await openHostedFile(innerTask, h.deps, h.orbId, "index.html", context);
            expect(opened.isOk()).toBe(true);
            if (opened.isErr()) return;
            await removeHostedFile(
              innerTask,
              h.deps,
              { orbId: h.orbId, runtimeTokenHash: "token", incarnation: 1 },
              "index.html",
              opened.value.file.object,
            );
            await cleanupRetiredHostedFiles(
              innerTask,
              h.deps,
              { leaseMs: 1_000, limit: 10 },
              context,
            );
            const chunks: Uint8Array[] = [];
            for (;;) {
              const next = await opened.value.source.next(innerTask, context);
              expect(next.isOk()).toBe(true);
              if (next.isErr() || next.value === null) break;
              chunks.push(next.value);
            }
            expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("alpha");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("returns a typed interruption instead of EOF when deletion breaks a reader", async () => {
    const h = makeHostingHarness();
    await publishHostedFile(task, h.deps, h.request("request-a"), source("alpha"), context);
    h.interruptNextRead();
    const opened = await openHostedFile(task, h.deps, h.orbId, "index.html", context);
    expect(opened.isOk()).toBe(true);
    if (opened.isErr()) return;
    expect((await opened.value.source.next(task, context)).isOk()).toBe(true);
    await removeHostedFile(
      task,
      h.deps,
      { orbId: h.orbId, runtimeTokenHash: "token", incarnation: 1 },
      "index.html",
      opened.value.file.object,
    );
    await cleanupRetiredHostedFiles(task, h.deps, { leaseMs: 1_000, limit: 10 }, context);
    const interrupted = await opened.value.source.next(task, context);
    expect(interrupted.isErr() && interrupted.error.type).toBe("hosting_retryable");
  });

  it("recovers expired cleanup ownership after a worker dies and completion arrives", async () => {
    await runDst({ name: "hosting-cleaner-death-late-completion", iterations: 20 }, async (sim) => {
      const h = makeHostingHarness();
      h.seedCompletedUpload();
      const result = await sim.runTasks([
        {
          name: "dead-cleaner-and-successor",
          f: async (innerTask) => {
            await h.deps.store.beginOrbCleanup(innerTask, h.orbId);
            const abandoned = await h.deps.store.claimCleanup(innerTask, {
              orbId: h.orbId,
              now: innerTask.wallNow(),
              leaseUntil: innerTask.wallNow() + 10,
              limit: 10,
            });
            expect(abandoned.isOk() && abandoned.value).toHaveLength(1);
            await innerTask.sleep(11, "cleanup owner dies past its lease");
            const recovered = await cleanupRetiredHostedFiles(
              innerTask,
              h.deps,
              { leaseMs: 1_000, limit: 10, orbId: h.orbId },
              context,
            );
            expect(recovered.isOk() && recovered.value).toBe(1);
            expect(h.ownedObjects()).toEqual([]);
            h.assertOwnership();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("emits no healthy cleanup event and deduplicates one unchanged blocker", async () => {
    const probabilities: Record<string, number> = {
      [FAILPOINTS.hostingDeleteExact]: 1,
    };
    await runDst(
      {
        name: "hosting-cleanup-observability-edges",
        iterations: 1,
        failpointProbabilities: probabilities,
      },
      async (sim) => {
        const h = makeHostingHarness();
        const result = await sim.runTasks([
          {
            name: "cleaner",
            f: async (innerTask) => {
              expect(
                (
                  await cleanupRetiredHostedFiles(
                    innerTask,
                    h.deps,
                    { leaseMs: 1, limit: 10 },
                    context,
                  )
                )._unsafeUnwrap(),
              ).toBe(0);
              expect(h.events()).toEqual([]);
              await publishHostedFile(
                innerTask,
                h.deps,
                h.request("request-a"),
                source("alpha"),
                context,
              );
              await publishHostedFile(
                innerTask,
                h.deps,
                h.request("request-b"),
                source("bravo"),
                context,
              );
              await cleanupRetiredHostedFiles(
                innerTask,
                h.deps,
                { leaseMs: 1, limit: 10 },
                context,
              );
              await innerTask.sleep(2, "blocked cleanup claim expires");
              await cleanupRetiredHostedFiles(
                innerTask,
                h.deps,
                { leaseMs: 1, limit: 10 },
                context,
              );
              expect(h.events().filter((event) => event === "cleanup_blocked")).toHaveLength(1);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
  });

  it("rejects an adapter read for a different exact generation", async () => {
    await runDst({ name: "hosting-wrong-read-generation", iterations: 4 }, async (sim) => {
      const h = makeHostingHarness();
      await publishHostedFile(task, h.deps, h.request("request-a"), source("alpha"), context);
      const original = h.deps.bytes.openExact.bind(h.deps.bytes);
      const wrongGenerationBytes = new Proxy(h.deps.bytes, {
        get(target, property, receiver) {
          if (property !== "openExact") return Reflect.get(target, property, receiver);
          return (...args: Parameters<typeof original>) =>
            original(...args).map(({ object, source: body }) => ({
              object: { ...object, ref: { ...object.ref, generation: "wrong" } },
              source: body,
            }));
        },
      });
      const result = await sim.runTasks([
        {
          name: "reader",
          f: async (innerTask) => {
            const opened = await openHostedFile(
              innerTask,
              {
                ...h.deps,
                bytes: wrongGenerationBytes,
              },
              h.orbId,
              "index.html",
              context,
            );
            expect(opened.isErr()).toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("gives retirement work to one cleanup worker", async () => {
    await runDst({ name: "hosting-dual-cleanup-claim", iterations: 30 }, async (sim) => {
      const h = makeHostingHarness();
      await publishHostedFile(task, h.deps, h.request("request-a"), source("alpha"), context);
      await publishHostedFile(task, h.deps, h.request("request-b"), source("bravo"), context);
      const counts: number[] = [];
      const result = await sim.runTasks(
        ["a", "b"].map((owner) => ({
          name: owner,
          f: async (t: Parameters<typeof publishHostedFile>[0]) => {
            const cleaned = await cleanupRetiredHostedFiles(
              t,
              h.deps,
              { leaseMs: 1000, limit: 10 },
              context,
            );
            if (cleaned.isOk()) counts.push(cleaned.value);
          },
        })),
      );
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
      h.assertOwnership();
    });
  });

  it("sweeps an abandoned upload without waiting for a replay", async () => {
    const h = makeHostingHarness();
    h.seedInterruptedUpload();
    const cleaned = await cleanupRetiredHostedFiles(
      task,
      h.deps,
      { leaseMs: 1000, limit: 10, orbId: h.orbId },
      context,
    );
    expect(cleaned.isOk() && cleaned.value).toBe(1);
    expect(h.dataCapableSessions()).toBe(0);
  });
});
