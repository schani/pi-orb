import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { err, ok, okAsync, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeOrbRow } from "../../testkit/fixtures.ts";
import { DurableAgent } from "./agent.ts";
import { DurableAgentPlane, durableError } from "./manager.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const resources = () => ({
  models: createModels(),
  registry: createRegistry(),
  env: new NodeExecutionEnv({ cwd: "/tmp" }),
  checkoutCommit: null,
  instructions: "CP",
});

it("never retargets an authorized old alert or delivery to the post-Stop owner", async () => {
  const path = await mkdtemp(join(tmpdir(), "durable-epoch-alert-"));
  let version = 0;
  const plane = (
    await DurableAgentPlane.create({
      persistence: new MemoryAgentPersistence(),
      openContext: (_task, orb) =>
        okAsync({
          ...resources(),
          checkAdmission: () =>
            version === orb.agentAdmissionVersion
              ? okAsync(undefined)
              : ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
                  err(durableError("revoked")),
                ),
        }),
    })
  )._unsafeUnwrap();
  const task = new NoSimulationTask("alert-ABA", false);
  const context = { signal: new AbortController().signal };
  const old = makeOrbRow("orb", "project", "starting");
  try {
    await plane.health(task, old, context);
    // The native caller was authorized here; its callback has not entered the writer.
    version = 1;
    await plane.suspend(task, old.id, context, version);
    version = 2;
    const fresh = { ...old, agentAdmissionVersion: version };
    await plane.health(task, fresh, context);
    expect(
      (
        await plane.appendAlert(old.id, "old-alert", "STALE ALERT", old.agentAdmissionVersion)
      ).isErr(),
    ).toBe(true);
    expect(
      (
        await plane.deliverMessage(
          task,
          old,
          {
            baseUrl: "central",
            messageId: "old-message",
            messageIds: [],
            content: [{ type: "text", text: "STALE MESSAGE" }],
          },
          context,
        )
      ).isErr(),
    ).toBe(true);
    expect((await plane.appendAlert(old.id, "fresh-alert", "fresh", version)).isOk()).toBe(true);
    expect(JSON.stringify(plane.session(old.id)?.snapshot()._unsafeUnwrap().records)).not.toContain(
      "STALE",
    );
  } finally {
    await plane.close();
    await rm(path, { recursive: true, force: true });
  }
});

it("checks revocation inside the serialized alert effect and rejects queued delivery on close", async () => {
  const entered = barrier();
  const release = barrier();
  let guardCalls = 0;
  let hold = false;
  let revoked = false;
  const agent = (
    await DurableAgent.open({
      ...resources(),
      orbId: "orb",
      storage: new MemoryStorage(),
      checkAdmission: () => {
        if (!hold) return okAsync(undefined);
        guardCalls++;
        if (guardCalls !== 2) return okAsync(undefined);
        entered.resolve();
        return ResultAsync.fromSafePromise(release.promise).andThen(() =>
          revoked ? err(durableError("revoked")) : ok(undefined),
        );
      },
    })
  )._unsafeUnwrap();
  try {
    hold = true;
    const alert = agent.appendAlert("alert", "STALE EFFECT");
    await entered.promise;
    const queued = agent.deliver({
      baseUrl: "central",
      messageId: "queued",
      messageIds: [],
      content: [{ type: "text", text: "STALE QUEUED" }],
    });
    revoked = true;
    agent.revoke();
    release.resolve();
    expect((await alert).isErr()).toBe(true);
    expect((await queued).isErr()).toBe(true);
    expect(JSON.stringify(agent.snapshot()._unsafeUnwrap().records)).not.toContain("STALE");
  } finally {
    release.resolve();
    await agent.close();
  }
});
