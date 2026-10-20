import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { SimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { expect } from "vitest";
import { composeControlPlaneDatabase } from "../adapters/database.ts";
import { DurableAgentPlane, durableError } from "../adapters/durable/manager.ts";
import type { AgentPersistence } from "../adapters/durable/persistence.ts";
import { PGliteClient } from "../adapters/pg/pglite-client.ts";
import { ControlState } from "../domain/control-state.ts";
import { enqueueOrbMessage } from "../domain/lifecycle.ts";
import { pollAllOnce, reconcileAllOnce } from "../domain/loops.ts";
import type { ControlPlaneDeps } from "../domain/ports.ts";
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
  let database = composeControlPlaneDatabase(client);
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
      const input = context.messages.filter((message) => message.role === "user").at(-1);
      const text =
        typeof input?.content === "string"
          ? input.content
          : input?.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
      const stream = createAssistantMessageEventStream();
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        pending.delete(finish);
        options?.signal?.removeEventListener("abort", abort);
        const message = fauxAssistantMessage(`completed:${text}`);
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
  const history: string[] = [];

  async function replace(ownerTask: SimulationTask) {
    if (plane) {
      (await plane.close())._unsafeUnwrap();
      // close joins ownership renewal before the task is reused.
      (await database.agentPersistence.close())._unsafeUnwrap();
      database = composeControlPlaneDatabase(client);
      generation++;
    }
    const persistence = database.agentPersistence;
    const routed: AgentPersistence = {
      recoveryDemand: (task, orb, context) => persistence.recoveryDemand(task, orb, context),
      checkStartup: (task, orb, context) =>
        persistence.checkStartup?.(task, orb, context) ?? okAsync(undefined),
      open: (_task, orb, context) => persistence.open(ownerTask, orb, context),
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
    const orb = (await database.store.getOrb(task, CENTRAL_WORK_ORB))._unsafeUnwrap();
    const messages = (await database.store.listOrbMessages(task, CENTRAL_WORK_ORB))._unsafeUnwrap();
    const snapshot = (
      await database.store.readHistorySnapshot(task, CENTRAL_WORK_ORB)
    )._unsafeUnwrap();
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
      const submission = native.find(
        (entry) => JSON.parse(String(entry.record)).requestId === `inbox:${id}`,
      );
      const row = messages.find((message) => message.messageId === id);
      if (row?.operationId) {
        expect(row.operationId, "public operation identifies original native submission").toBe(
          `conversation:${CENTRAL_WORK_ORB}:submission:${submission?.id}`,
        );
        expect(
          operation === null || operation === row.operationId,
          "stable operation identity",
        ).toBe(true);
        accepted.set(id, row.operationId);
      }
    }
    return {
      history: [...history],
      generation,
      opens,
      entered,
      orb,
      messages,
      native,
      tasks,
      records: snapshot.records,
    };
  }

  async function complete(task: SimulationTask) {
    const state = await inspect(task);
    const outcomes = [...accepted].map(([id, operation]) => {
      const submission = state.native.filter(
        (row) => JSON.parse(String(row.record)).requestId === `inbox:${id}`,
      );
      const users = state.records.filter(
        (row) =>
          row.type === "message" &&
          row.role === "user" &&
          row.content.some((part) => part.type === "text" && part.text === id),
      );
      const answers = state.records.filter(
        (row) =>
          row.type === "message" &&
          row.role === "assistant" &&
          row.content.some((part) => part.type === "text" && part.text === `completed:${id}`),
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

  return {
    initialize,
    restart: replace,
    release: () => {
      held = false;
      for (const finish of [...pending]) finish();
    },
    inspect,
    complete,
    command: (value: string) => history.push(value),
    submit: async (task: SimulationTask, id: string) => {
      (
        await enqueueOrbMessage(task, deps, {
          orbId: CENTRAL_WORK_ORB,
          messageId: id,
          content: [{ type: "text", text: id }],
        })
      )._unsafeUnwrap();
      if (!accepted.has(id)) accepted.set(id, null);
      history.push(`submit:${id}`);
    },
    poll: (task: SimulationTask) => pollAllOnce(task, deps),
    reconcile: (task: SimulationTask) => reconcileAllOnce(task, deps),
    tick: async (task: SimulationTask) => {
      await pollAllOnce(task, deps);
      await reconcileAllOnce(task, deps);
    },
    close: async () => {
      if (plane) (await plane.close())._unsafeUnwrap();
      (await database.close())._unsafeUnwrap();
    },
  };
}
