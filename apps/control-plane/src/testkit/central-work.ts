import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { SimulationTask } from "determined";
import { okAsync, ResultAsync } from "neverthrow";
import { expect } from "vitest";
import { composeControlPlaneDatabase } from "../adapters/database.ts";
import { DurableAgentPlane, durableError } from "../adapters/durable/manager.ts";
import type { AgentPersistence } from "../adapters/durable/persistence.ts";
import { PgAgentPersistence } from "../adapters/durable/pg-persistence.ts";
import type { PostgreSQLClient } from "../adapters/pg/client.ts";
import { PGliteClient } from "../adapters/pg/pglite-client.ts";
import { PostgreSQLControlPlaneStore } from "../adapters/pg/store.ts";
import { ControlState } from "../domain/control-state.ts";
import { enqueueOrbMessage } from "../domain/lifecycle.ts";
import { pollAllOnce, reconcileAllOnce } from "../domain/loops.ts";
import type { ControlPlaneDeps } from "../domain/ports.ts";
import { pollOrbUntilCaughtUp } from "../domain/replication.ts";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  seedProvisionedHost,
  seedTestUser,
} from "./fixtures.ts";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Native AbortSignal.any requires a branded signal; determined owns the timer. */
export function nativeDeadlineTask(task: SimulationTask): SimulationTask {
  return {
    ...task,
    createDeadline: (ms, reason) => {
      const deadline = task.createDeadline(ms, reason);
      const controller = new AbortController();
      const abort = () => controller.abort(deadline.signal.reason);
      if (deadline.signal.aborted) abort();
      else deadline.signal.addEventListener("abort", abort, { once: true });
      return {
        signal: controller.signal,
        cancel: () => {
          deadline.signal.removeEventListener("abort", abort);
          deadline.cancel();
        },
      };
    },
  };
}

export const CENTRAL_WORK_ORB = "00000000-0000-4000-8000-000000000071";

/** One orb, retained native/public SQL, fake compute, and an interruptible model. */
export async function centralWorkHarness() {
  // Finish WASM/filesystem initialization before entering determined. Subsequent
  // in-memory SQL executes through microtasks; no network or filesystem backend.
  const client = new PGliteClient();
  const history: string[] = [];
  // A stalled request waits before entering PGlite, never while holding its lock.
  // The environment actor owns time; database callers only await this gate.
  let stall: ReturnType<typeof deferred> | undefined;
  let blocked = 0;
  type Latency = { phase: "admission" | "completion"; ms: number } | null;
  let latencyPlan: readonly Latency[] = [];
  let operation = 0;
  let deliveryWake = deferred();
  let deliveryFinished = false;
  const deliveries: { due: number; waiting: ReturnType<typeof deferred>; id: number }[] = [];
  const boundary = (phase: "admission" | "completion", id: number) => {
    const latency = latencyPlan[id % latencyPlan.length];
    if (!latency || latency.phase !== phase) return Promise.resolve();
    const waiting = deferred();
    history.push(`${clock.wallNow()}:database:hold:${id}:${phase}`);
    deliveries.push({ due: clock.monotonicNow() + latency.ms, waiting, id });
    deliveryWake.resolve();
    return waiting.promise;
  };
  let clock: SimulationTask;
  const faultClient: PostgreSQLClient = {
    query: (sql, values) => {
      const id = operation++;
      const waiting = stall;
      if (waiting) blocked++;
      return ResultAsync.fromSafePromise(waiting?.promise ?? Promise.resolve())
        .andThen(() => ResultAsync.fromSafePromise(boundary("admission", id)))
        .andThen(() => client.query(sql, values))
        .andThen((value) =>
          ResultAsync.fromSafePromise(boundary("completion", id)).map(() => value),
        );
    },
    transaction: (f) => {
      const id = operation++;
      const waiting = stall;
      if (waiting) blocked++;
      return (
        ResultAsync.fromSafePromise(waiting?.promise ?? Promise.resolve())
          .andThen(() => ResultAsync.fromSafePromise(boundary("admission", id)))
          .andThen(() => client.transaction(f))
          // The transaction has released PGlite's lock before delivery is delayed.
          .andThen((value) => {
            history.push(
              `${clock?.wallNow()}:database:transaction-completed:${id}:${typeof value}`,
            );
            return ResultAsync.fromSafePromise(boundary("completion", id)).map(() => value);
          })
      );
    },
    end: () => client.end(),
  };
  const observer = new PostgreSQLControlPlaneStore(client);
  const compose = () => {
    const database = composeControlPlaneDatabase(faultClient);
    return {
      ...database,
      agentPersistence: new PgAgentPersistence(faultClient, database.store, () =>
        Math.floor(clock.wallNow()),
      ),
    };
  };
  let database = compose();
  (await database.migrate())._unsafeUnwrap();
  const host = makeHarness();
  const models = createModels();
  const faux = fauxProvider();
  let held = true;
  let entered = 0;
  let opens = 0;
  let generation = 0;
  const pending = new Set<() => void>();
  models.setProvider({
    ...faux.provider,
    streamSimple: (_model, context, options) => {
      entered++;
      const blocks = context.messages.flatMap((message) => {
        const texts =
          typeof message.content === "string"
            ? [message.content]
            : message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
        return texts.map((text) => ({ role: message.role, text }));
      });
      const ids = (text: string) =>
        text.match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g) ?? [];
      const answered = new Set(
        blocks.filter((block) => block.role === "assistant").flatMap((block) => ids(block.text)),
      );
      const pendingIds = new Set(
        blocks.filter((block) => block.role === "user").flatMap((block) => ids(block.text)),
      );
      const answer = [...pendingIds]
        .filter((id) => !answered.has(id))
        .map((id) => `completed:${id}`)
        .join("\n");
      const stream = createAssistantMessageEventStream();
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        pending.delete(finish);
        options?.signal?.removeEventListener("abort", abort);
        const message = fauxAssistantMessage(answer);
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        pending.delete(finish);
        const error = fauxAssistantMessage("", { stopReason: "aborted" });
        stream.push({ type: "error", reason: "aborted", error });
        stream.end();
      };
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.signal?.aborted) abort();
      else if (held) pending.add(finish);
      else finish();
      return stream;
    },
  });
  let plane: DurableAgentPlane | undefined;
  let deps: ControlPlaneDeps;
  const accepted = new Map<string, string | null>();
  const committedRecords = new Map<string, string>();

  async function replace(ownerTask: SimulationTask) {
    if (plane) {
      (await plane.close())._unsafeUnwrap();
      // close joins ownership renewal before the task is reused.
      (await database.agentPersistence.close())._unsafeUnwrap();
      database = compose();
      generation++;
    }
    const persistence = database.agentPersistence;
    const routed: AgentPersistence = {
      recoveryDemand: (task, orb, context) => persistence.recoveryDemand(task, orb, context),
      checkStartup: (task, orb, context) =>
        persistence.checkStartup?.(task, orb, context) ?? okAsync(undefined),
      open: (_task, orb, context) =>
        persistence.open(ownerTask, orb, context).map((lease) => {
          return {
            ...lease,
            beginDrain: () =>
              lease
                .beginDrain()
                .andTee(() => {
                  history.push(`${ownerTask.wallNow()}:drain:ok`);
                })
                .mapErr((error) => {
                  history.push(`${ownerTask.wallNow()}:drain:error:${error.message}`);
                  return error;
                }),
            release: () =>
              lease
                .release()
                .andTee(() => {
                  history.push(`${ownerTask.wallNow()}:release:ok`);
                })
                .mapErr((error) => {
                  history.push(`${ownerTask.wallNow()}:release:error:${error.message}`);
                  return error;
                }),
          };
        }),
      snapshot: (task, orb) => persistence.snapshot(task, orb),
      dispose: (task, id, authority) => persistence.dispose(task, id, authority),
      close: () => persistence.close(),
    };
    plane = (
      await DurableAgentPlane.create({
        persistence: routed,
        currentOrb: (task, id) =>
          database.store.getOrb(task, id).mapErr(() => durableError("orb read failed")),
        openContext: (task) => {
          opens++;
          return okAsync({
            models,
            registry: createRegistry(),
            env: new NodeExecutionEnv({ cwd: "/tmp" }),
            checkoutCommit: "commit-0",
            instructions: "",
            edge: (name) => {
              history.push(`${task.wallNow()}:${name}`);
              return okAsync(undefined);
            },
            now: () => task.wallNow(),
            initialSettings: {
              model: { provider: "faux", id: "faux-1" },
              thinkingLevel: "off" as const,
            },
          });
        },
      })
    )._unsafeUnwrap();
    deps = { ...host.deps, store: database.store, agentPlane: plane, control: new ControlState() };
    history.push(`restart:${generation}`);
  }

  async function initialize(task: SimulationTask, ownerTask: SimulationTask) {
    clock = ownerTask;
    (await seedTestUser(task, database.users))._unsafeUnwrap();
    const project = makeProjectRow("00000000-0000-4000-8000-000000000072");
    host.world.configureOrb(CENTRAL_WORK_ORB, { initDurationMs: 0 });
    const provisioned = seedProvisionedHost(task, host, CENTRAL_WORK_ORB, {
      repositoryUrl: project.repositoryUrl,
    });
    host.world.finishBoot(task, CENTRAL_WORK_ORB);
    host.world.ensureSessionExists(CENTRAL_WORK_ORB);
    const orb = makeOrbRow(CENTRAL_WORK_ORB, project.id, "running", {
      hostRef: provisioned.ref.resourceId,
      runtimeTokenHash: provisioned.runtimeTokenHash,
      hostSpecFingerprint: provisioned.specFingerprint,
      hostSpecGeneration: provisioned.specGeneration,
      checkoutCommit: "commit-0",
      lastReadyAt: task.wallNow(),
      stateChangedAt: task.wallNow(),
    });
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    (await database.store.insertOrb(task, orb))._unsafeUnwrap();
    await replace(ownerTask);
  }

  async function inspect(task: SimulationTask) {
    const orb = (await observer.getOrb(task, CENTRAL_WORK_ORB))._unsafeUnwrap();
    const messages = (await observer.listOrbMessages(task, CENTRAL_WORK_ORB))._unsafeUnwrap();
    const snapshot = (await observer.readHistorySnapshot(task, CENTRAL_WORK_ORB))._unsafeUnwrap();
    expect(
      new Set(snapshot.records.map((record) => record.id)).size,
      "unique committed record identities",
    ).toBe(snapshot.records.length);
    if (snapshot.cursor !== null)
      expect(
        snapshot.records.map((record) => record.id),
        "committed cursor belongs to authoritative history",
      ).toContain(snapshot.cursor);
    for (const record of snapshot.records) {
      const bytes = JSON.stringify(record);
      expect(committedRecords.get(record.id) ?? bytes, "committed records are immutable").toBe(
        bytes,
      );
      committedRecords.set(record.id, bytes);
    }
    const native = (
      await client.query(
        "SELECT id,request_id,status,record FROM durable_pg_submissions WHERE orb_id=$1 ORDER BY id",
        [CENTRAL_WORK_ORB],
      )
    )._unsafeUnwrap().rows;
    const tasks = (
      await client.query(
        "SELECT id,status,record FROM durable_pg_tasks WHERE orb_id=$1 ORDER BY id",
        [CENTRAL_WORK_ORB],
      )
    )._unsafeUnwrap().rows;
    for (const [id, operation] of accepted) {
      const row = messages.find((message) => message.messageId === id);
      const submission = native.find(
        (entry) =>
          JSON.parse(String(entry.record)).requestId === `inbox:${row?.deliveryBatchId ?? id}`,
      );
      if (row?.operationId) {
        expect(submission, "delivered input has a native submission").toBeDefined();
        expect(
          native.map((entry) => `conversation:${CENTRAL_WORK_ORB}:submission:${entry.id}`),
          "public operation identifies a persisted native submission",
        ).toContain(row.operationId);
        expect(
          operation === null || operation === row.operationId,
          "stable operation identity",
        ).toBe(true);
        accepted.set(id, row.operationId);
      }
    }
    const owners = (
      await client.query(
        "SELECT fence,admission_version,lease_until FROM durable_pg_owners WHERE orb_id=$1",
        [CENTRAL_WORK_ORB],
      )
    )._unsafeUnwrap().rows;
    const ownerEvents = (
      await client.query(
        "SELECT fence,outcome,recorded_at FROM durable_pg_owner_events WHERE orb_id=$1 ORDER BY recorded_at",
        [CENTRAL_WORK_ORB],
      )
    )._unsafeUnwrap().rows;
    return {
      at: task.wallNow(),
      database: { stalled: Boolean(stall), blocked },
      owners,
      ownerEvents,
      history: [...history],
      generation,
      opens,
      entered,
      orb,
      messages,
      native,
      tasks,
      records: snapshot.records,
      accepted: [...accepted],
    };
  }

  function complete(state: Awaited<ReturnType<typeof inspect>>) {
    const outcomes = state.accepted.map(([id, operation]) => {
      const message = state.messages.find((row) => row.messageId === id);
      const submission = state.native.filter(
        (row) =>
          JSON.parse(String(row.record)).requestId === `inbox:${message?.deliveryBatchId ?? id}`,
      );
      const users = state.records.flatMap((row) => {
        if (row.type !== "message" || row.role !== "user") return [];
        const occurrences = row.content.flatMap((part) =>
          part.type === "text" ? part.text.split(/\s+/).filter((text) => text === id) : [],
        );
        if (occurrences.length > 0)
          expect(row.inboxMessageIds, "original input retains inbox provenance").toContain(id);
        return occurrences;
      });
      const answers = state.records.flatMap((row) =>
        row.type === "message" && row.role === "assistant"
          ? row.content.flatMap((part) =>
              part.type === "text"
                ? part.text.split("\n").filter((text) => text === `completed:${id}`)
                : [],
            )
          : [],
      );
      expect(users.length, "no duplicate original input").toBeLessThanOrEqual(1);
      expect(answers.length, "no duplicate completed effect").toBeLessThanOrEqual(1);
      expect(submission.length, "no duplicate native submission").toBeLessThanOrEqual(1);
      return (
        operation !== null &&
        submission[0]?.status === "done" &&
        users.length === 1 &&
        answers.length === 1 &&
        state.tasks.every((row) => {
          const record = JSON.parse(String(row.record));
          return row.status === "terminal" && record.state.outcome.status === "completed";
        })
      );
    });
    return outcomes.every(Boolean);
  }

  function deliverDatabaseReplies(finish = false) {
    for (let i = deliveries.length - 1; i >= 0; i--) {
      const delivery = deliveries[i];
      if (delivery && (finish || delivery.due <= clock.monotonicNow())) {
        deliveries.splice(i, 1);
        history.push(`${clock.wallNow()}:database:delivered:${delivery.id}`);
        delivery.waiting.resolve();
      }
    }
    if (finish) latencyPlan = [];
  }

  return {
    initialize,
    restart: replace,
    release: () => {
      held = false;
      for (const finish of [...pending]) finish();
    },
    inspect,
    complete,
    command: (value: string) => history.push(`${clock?.wallNow()}:${value}`),
    finishDatabaseLatency: () => {
      deliveryFinished = true;
      deliveryWake.resolve();
    },
    deliverDatabaseReplies,
    serveDatabaseReplies: async (task: SimulationTask) => {
      while (!deliveryFinished) {
        if (deliveries.length === 0) await deliveryWake.promise;
        deliveryWake = deferred();
        if (deliveries.length > 0) {
          await task.sleep(25, "database reply delivery");
          deliverDatabaseReplies();
        }
      }
      deliverDatabaseReplies(true);
    },
    databaseLatencyPlan: (plan: readonly Latency[]) => {
      latencyPlan = plan;
      operation = 0;
    },
    historyIntervalMs: host.deps.constants.historyPullIntervalMs,
    pollHistory: (task: SimulationTask) => pollOrbUntilCaughtUp(task, deps, CENTRAL_WORK_ORB),
    databaseStall: (stalled: boolean) => {
      history.push(`${clock?.wallNow()}:database:${stalled ? "stalled" : "healthy"}`);
      if (stalled) stall ??= deferred();
      else {
        const waiting = stall;
        stall = undefined;
        waiting?.resolve();
      }
    },
    submit: async (task: SimulationTask, id: string) => {
      const result = await enqueueOrbMessage(task, deps, {
        orbId: CENTRAL_WORK_ORB,
        messageId: id,
        content: [{ type: "text", text: id }],
      });
      result._unsafeUnwrap();
      if (!accepted.has(id)) accepted.set(id, null);
      history.push(`${task.wallNow()}:submit:${id}:accepted`);
    },
    poll: (task: SimulationTask) => pollAllOnce(task, deps),
    reconcile: (task: SimulationTask) => reconcileAllOnce(task, deps),
    tick: async (task: SimulationTask) => {
      await pollAllOnce(task, deps);
      await reconcileAllOnce(task, deps);
    },
    close: async () => {
      const planeResult = await plane?.close();
      const persistenceResult = await database.agentPersistence.close();
      const clientResult = await client.end();
      return {
        plane: planeResult?.isErr() ? planeResult.error : null,
        persistence: persistenceResult.isErr() ? persistenceResult.error : null,
        client: clientResult.isErr() ? clientResult.error : null,
      };
    },
  };
}
