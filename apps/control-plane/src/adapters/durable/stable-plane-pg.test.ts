import { randomUUID } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ServerFrame } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { DurableAgentPlane, durableError } from "./manager.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("keeps a PG-backed subscribed handle across stopped quiescent unload and replacement, with passive history and no resource reopen", async () => {
  const db = new PGliteClient(),
    database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("stable-plane-pg", false);
  const project = makeProjectRow(randomUUID());
  let orb = makeOrbRow(randomUUID(), project.id, "running");
  let opens = 0,
    dispatches = 0,
    closed = 0,
    invalidations = 0;
  const models = createModels(),
    faux = fauxProvider();
  faux.setResponses([
    () => {
      dispatches++;
      return fauxAssistantMessage("first answer");
    },
    () => {
      dispatches++;
      return fauxAssistantMessage("second answer");
    },
  ]);
  models.setProvider(faux.provider);
  const finished = [barrier(), barrier()];
  const frames: ServerFrame[] = [];
  const plane = (
    await DurableAgentPlane.create({
      persistence: database.agentPersistence,
      currentOrb: () =>
        database.store.getOrb(task, orb.id).mapErr(() => durableError("orb read failed")),
      openContext: () => {
        opens++;
        return okAsync({
          models,
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: "pin",
          instructions: "instructions",
          initialSettings: {
            model: { provider: "faux", id: "faux-1" },
            thinkingLevel: "off" as const,
          },
          closeResources: () => {
            closed++;
            return okAsync(undefined);
          },
        });
      },
    })
  )._unsafeUnwrap();
  const context = { signal: new AbortController().signal };
  let detach: () => void = () => undefined;
  try {
    (await database.migrate())._unsafeUnwrap();
    (
      await database.users.resolveUser(
        task,
        { issuer: "test", subject: "owner", email: null },
        { id: project.ownerUserId, now: 0 },
      )
    )._unsafeUnwrap();
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    (await database.store.insertOrb(task, orb))._unsafeUnwrap();
    const handle = (await plane.readSession(task, orb, context))._unsafeUnwrap();
    const empty = (await handle.readSnapshot!())._unsafeUnwrap();
    expect(empty.records).toEqual([]);
    expect(opens).toBe(0);
    let turns = 0;
    detach = handle.subscribe(
      (frame) => {
        frames.push(frame);
        if (frame.type === "runtime.event" && frame.event.type === "operation_finished")
          finished[turns++]?.resolve();
      },
      () => {
        invalidations++;
      },
    );
    (await plane.health(task, orb, context))._unsafeUnwrap();
    expect(handle.snapshot()._unsafeUnwrap().session.id).toBe(empty.session.id);
    (
      await plane.deliverMessage(
        task,
        orb,
        {
          baseUrl: "unused",
          messageId: randomUUID(),
          messageIds: [],
          content: [{ type: "text", text: "first" }],
        },
        context,
      )
    )._unsafeUnwrap();
    await finished[0]!.promise;
    const before = (await handle.readSnapshot!())._unsafeUnwrap();
    expect(dispatches).toBe(1);
    // Running compute cannot unload even when the native Harness is idle.
    expect((await plane.unload(task, orb, context))._unsafeUnwrap()).toBe(false);
    (
      await db.query("UPDATE orbs SET state='stopped', stop_reason='idle' WHERE id=$1", [orb.id])
    )._unsafeUnwrap();
    orb = (await database.store.getOrb(task, orb.id))._unsafeUnwrap()!;
    expect((await plane.unload(task, orb, context))._unsafeUnwrap()).toBe(true);
    expect(closed).toBe(1);
    expect(invalidations).toBe(0);
    expect(plane.session(orb.id)).toBe(handle);
    expect(handle.snapshot()._unsafeUnwrap().records).toEqual([]);
    const passive = (await handle.readSnapshot!())._unsafeUnwrap();
    expect(passive.records).toEqual(before.records);
    expect(passive.session.id).toBe(before.session.id);
    expect(opens).toBe(1);
    expect(dispatches).toBe(1);
    const frameCount = frames.length;
    (
      await db.query(
        "UPDATE orbs SET state='running',stop_reason=NULL,agent_admission_version=1 WHERE id=$1",
        [orb.id],
      )
    )._unsafeUnwrap();
    orb = (await database.store.getOrb(task, orb.id))._unsafeUnwrap()!;
    (await plane.health(task, orb, context))._unsafeUnwrap();
    (
      await plane.deliverMessage(
        task,
        orb,
        {
          baseUrl: "unused",
          messageId: randomUUID(),
          messageIds: [],
          content: [{ type: "text", text: "second" }],
        },
        context,
      )
    )._unsafeUnwrap();
    await finished[1]!.promise;
    expect(opens).toBe(2);
    expect(dispatches).toBe(2);
    expect(invalidations).toBe(0);
    expect(plane.session(orb.id)).toBe(handle);
    expect(frames.slice(frameCount).some((frame) => frame.type === "history.record")).toBe(true);
    expect(JSON.stringify((await handle.readSnapshot!())._unsafeUnwrap().records)).toContain(
      "second answer",
    );
  } finally {
    detach();
    await plane.close();
    await database.close();
  }
});
