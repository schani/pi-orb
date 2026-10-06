import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeOrbRow } from "../../testkit/fixtures.ts";
import { DurableAgentPlane } from "./manager.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

it("keeps the same conversation handle across explicit suspension/reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stable-plane-"));
  const plane = (
    await DurableAgentPlane.create({
      persistence: new MemoryAgentPersistence(),
      openContext: () =>
        okAsync({
          models: createModels(),
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: directory }),
          checkoutCommit: null,
          instructions: "instructions",
        }),
    })
  )._unsafeUnwrap();
  const task = new NoSimulationTask("handle-reopen", false);
  const context = { signal: new AbortController().signal };
  const orb = makeOrbRow("orb", "project", "stopped");
  try {
    (await plane.health(task, orb, context))._unsafeUnwrap();
    const first = plane.session(orb.id);
    expect(first).not.toBeNull();
    let invalidated = false;
    first?.subscribe(
      () => undefined,
      () => {
        invalidated = true;
      },
    );
    (await plane.suspend(task, orb.id, context))._unsafeUnwrap();
    expect(plane.session(orb.id)).toBe(first);
    (
      await plane.health(
        task,
        { ...orb, agentAdmissionVersion: orb.agentAdmissionVersion + 1 },
        context,
      )
    )._unsafeUnwrap();
    expect(plane.session(orb.id)).toBe(first);
    expect(invalidated).toBe(false);
  } finally {
    await plane.close();
    await rm(directory, { recursive: true, force: true });
  }
});
