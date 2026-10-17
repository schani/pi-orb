import { randomUUID } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, type Storage, StorageRequestError } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ServerFrame } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import type { StoreError } from "../../domain/errors.ts";
import { makeOrbRow, makeProjectRow, seedTestUser } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import type { AuthorityError } from "../durable-pg/index.ts";
import { StorageFailure } from "../durable-pg/storage-boundary.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { DurableAgent } from "./agent.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const unavailable: StoreError = {
  type: "store_error",
  code: "unavailable",
  message: "private injected database diagnostic",
  retryable: true,
};
const staleOwner: AuthorityError = {
  type: "authority_error",
  code: "stale_owner",
  message: "Owner revoked",
};

it.each([
  "identity-io",
  "refusal-identity-io",
  "preflight-db",
  "identity-fence",
  "invalid-read",
] as const)("handles native preflight fault: %s", async (position) => {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("preflight-fault", false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "running");
  const storageEntered = barrier(),
    storageRelease = barrier();
  const resourcesEntered = barrier(),
    resourcesRelease = barrier();
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const frames: ServerFrame[] = [];
  const edges: { code: string; facts: Readonly<Record<string, string | number | boolean>> }[] = [];
  let agent: DurableAgent | undefined;
  let storageClosed = 0;
  let resourcesClosed = 0;
  let storageWork = 0;
  let commits = 0;
  let lookups = 0;
  let inject = false;
  let invalidated = 0;
  const query = db.query.bind(db);
  const querySpy = vi.spyOn(db, "query").mockImplementation((sql, values) => {
    if (
      inject &&
      position === "preflight-db" &&
      sql === "SELECT sleep_id,stop_reason FROM orbs WHERE id=$1"
    )
      return errAsync(unavailable);
    return query(sql, values);
  });
  try {
    (await database.migrate())._unsafeUnwrap();
    (await seedTestUser(task, database.users))._unsafeUnwrap();
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    (await database.store.insertOrb(task, orb))._unsafeUnwrap();
    const lease = (
      await database.agentPersistence.open(task, orb, { signal: new AbortController().signal })
    )._unsafeUnwrap();
    const storage = new Proxy(lease.storage, {
      get(target, key) {
        if (key === "close")
          return async (...args: Parameters<Storage["close"]>) => {
            storageEntered.resolve();
            await storageRelease.promise;
            await target.close(...args);
            storageClosed++;
          };
        if (key === "submissionByRequest")
          return (...args: Parameters<Storage["submissionByRequest"]>) => {
            storageWork++;
            lookups++;
            if (
              inject &&
              position !== "preflight-db" &&
              (position !== "refusal-identity-io" || lookups === 2)
            )
              return Promise.reject(
                position === "invalid-read"
                  ? new StorageRequestError("Invalid effect-free lookup")
                  : new StorageFailure("Native identity unavailable", {
                      cause: position === "identity-fence" ? staleOwner : unavailable,
                    }),
              );
            return target.submissionByRequest(...args);
          };
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          storageWork++;
          if (key === "commit" && inject) commits++;
          return Reflect.apply(value, target, args);
        };
      },
    });
    agent = (
      await DurableAgent.open({
        orbId: orb.id,
        storage,
        models,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "",
        initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
        ownershipSignal: lease.signal,
        checkAdmission: lease.check,
        checkInputAdmission: lease.checkInputAdmission,
        beginDrain: lease.beginDrain,
        edge: (code, facts) => {
          edges.push({ code, facts });
          return okAsync(undefined);
        },
        closeResources: () =>
          ResultAsync.fromSafePromise(
            (async () => {
              resourcesEntered.resolve();
              await resourcesRelease.promise;
              const result = await lease.release();
              resourcesClosed++;
              return result;
            })(),
          ).andThen((result) => result),
      })
    )._unsafeUnwrap();
    agent.subscribe(
      (frame) => frames.push(frame),
      () => {
        invalidated++;
      },
    );
    if (position === "refusal-identity-io")
      (
        await database.store.scheduleOrbSleep(task, {
          orbId: orb.id,
          caller: {
            kind: "central",
            orbId: orb.id,
            projectId: project.id,
            ownerUserId: project.ownerUserId,
            agentAdmissionVersion: orb.agentAdmissionVersion,
          },
          sleepId: randomUUID(),
          durationSeconds: 300,
        })
      )._unsafeUnwrap();
    const input = {
      baseUrl: "central",
      messageId: randomUUID(),
      messageIds: [],
      content: [{ type: "text" as const, text: "must not reach inference" }],
    };
    lookups = 0;
    inject = true;
    const failed = (await agent.deliver(input))._unsafeUnwrapErr();
    expect(agent.health()).toMatchObject({
      status: position === "invalid-read" ? "ready" : "failed",
    });
    expect(faux.state.callCount).toBe(0);
    expect(commits).toBe(0);
    if (position === "invalid-read") {
      expect(agent.accepting()).toBe(true);
      expect(edges.filter((edge) => edge.code === "harness.storage_failed")).toEqual([]);
      expect(invalidated).toBe(0);
      inject = false;
      faux.setResponses([fauxAssistantMessage("valid continuation")]);
      const receipt = (await agent.deliver(input))._unsafeUnwrap();
      expect(receipt).toMatchObject({
        messageId: input.messageId,
        duplicate: false,
        delivery: "turn",
      });
      (await agent.waitForIdle())._unsafeUnwrap();
      expect(agent.health()).toMatchObject({ status: "ready", activity: "idle" });
      const records = agent.snapshot()._unsafeUnwrap().records;
      expect(
        records.filter((record) => record.type === "message" && record.role === "user"),
      ).toEqual([expect.objectContaining({ content: input.content })]);
      expect(
        records.filter((record) => record.type === "message" && record.role === "assistant"),
      ).toEqual([
        expect.objectContaining({ content: [{ type: "text", text: "valid continuation" }] }),
      ]);
      expect(faux.state.callCount).toBe(1);
      expect((await agent.deliver(input))._unsafeUnwrap()).toMatchObject({
        messageId: input.messageId,
        operationId: receipt.operationId,
        duplicate: true,
      });
      (await agent.waitForIdle())._unsafeUnwrap();
      expect(agent.snapshot()._unsafeUnwrap().records).toEqual(records);
      expect(faux.state.callCount).toBe(1);
      expect(agent.health()).toMatchObject({ status: "ready", activity: "idle" });
      expect(agent.accepting()).toBe(true);
      expect(edges.filter((edge) => edge.code === "harness.storage_failed")).toEqual([]);
      expect(frames.filter((frame) => frame.type === "server.error")).toEqual([]);
      expect(invalidated).toBe(0);
      return;
    }
    expect(agent.accepting()).toBe(false);
    expect(invalidated).toBe(1);
    expect(failed).toMatchObject({
      code: "history_unavailable",
      retryable: position !== "identity-fence",
    });
    if (position === "identity-fence") expect(failed.message).toBe(staleOwner.message);
    expect(JSON.stringify(failed)).not.toContain(unavailable.message);
    expect(lookups).toBe(position === "refusal-identity-io" ? 2 : 1);
    await storageEntered.promise;
    const before = storageWork;
    expect((await agent.deliver({ ...input, messageId: randomUUID() })).isErr()).toBe(true);
    expect(storageWork).toBe(before);
    const closing = agent.close();
    expect(agent.close()).toBe(closing);
    let joined = false;
    void closing.then(() => {
      joined = true;
    });
    expect(storageClosed).toBe(0);
    expect(resourcesClosed).toBe(0);
    expect(joined).toBe(false);
    storageRelease.resolve();
    await resourcesEntered.promise;
    expect(storageClosed).toBe(1);
    expect(resourcesClosed).toBe(0);
    expect(joined).toBe(false);
    resourcesRelease.resolve();
    (await closing)._unsafeUnwrap();
    expect(resourcesClosed).toBe(1);
    expect(lease.signal.aborted).toBe(true);
    expect(faux.state.callCount).toBe(0);
    expect(commits).toBe(0);
    expect(edges.filter((edge) => edge.code === "harness.storage_failed")).toEqual([
      {
        code: "harness.storage_failed",
        facts: {
          orbId: orb.id,
          code: position === "identity-fence" ? "stale_owner" : "unavailable",
        },
      },
    ]);
    expect(frames.filter((frame) => frame.type === "server.error")).toEqual([
      expect.objectContaining({
        type: "server.error",
        error: expect.objectContaining({ code: "central_agent_storage_failed" }),
      }),
    ]);
  } finally {
    storageRelease.resolve();
    resourcesRelease.resolve();
    await agent?.close();
    querySpy.mockRestore();
    await database.agentPersistence.close();
    await db.end();
  }
});
