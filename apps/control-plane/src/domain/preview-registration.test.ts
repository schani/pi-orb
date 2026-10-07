import assert from "node:assert/strict";
import { NoSimulationTask } from "determined";
import { errAsync, ok, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import * as registration from "./preview-registration.ts";
import { exposePreview, listRegisteredPreviews, unexposePreview } from "./preview-registration.ts";

it("authenticates a prepared token hash in the registration service", async () => {
  const task = new NoSimulationTask("preview authentication", false);
  const h = makeHarness();
  seedRunningOrb(task, h, "orb-a");
  const orb = h.store.orbSnapshot("orb-a");
  assert(orb?.runtimeTokenHash);
  expect(typeof registration.authenticatePreviewRegistration).toBe("function");
  const auth = await registration.authenticatePreviewRegistration(
    task,
    { store: h.store },
    orb.runtimeTokenHash,
  );
  expect(auth._unsafeUnwrap()).toEqual({
    orbId: orb.id,
    caller: { runtimeTokenHash: orb.runtimeTokenHash, hostIncarnation: orb.hostIncarnation },
  });
  const rotated = await h.store.casUpdateFields(task, {
    orbId: orb.id,
    expectedStateVersion: orb.stateVersion,
    runtimeTokenHash: "replacement",
    now: task.wallNow(),
  });
  expect(rotated.isOk()).toBe(true);
  const rejected = await exposePreview(
    task,
    {
      store: h.store,
      url: (id, port) => ok(`https://p${port}-o${id}.preview.test`),
      newId: () => "r1",
      reservedPort: 8080,
    },
    { ...auth._unsafeUnwrap(), port: 5173 },
  );
  expect(rejected.isErr() && rejected.error.code).toBe("unauthenticated");
});

it("rejects missing or mismatched runtime identities and maps store failures", async () => {
  const task = new NoSimulationTask("preview authentication errors", false);
  const h = makeHarness();
  seedRunningOrb(task, h, "orb-a");
  const orb = h.store.orbSnapshot("orb-a");
  assert(orb);
  expect(typeof registration.authenticatePreviewRegistration).toBe("function");
  for (const value of [null, { ...orb, runtimeTokenHash: "different" }]) {
    const result = await registration.authenticatePreviewRegistration(
      task,
      { store: { getOrbByRuntimeTokenHash: () => okAsync(value) } },
      "prepared-hash",
    );
    expect(result.isErr() && result.error.code).toBe("unauthenticated");
  }
  const failed = await registration.authenticatePreviewRegistration(
    task,
    {
      store: {
        getOrbByRuntimeTokenHash: () =>
          errAsync({
            type: "store_error",
            code: "unavailable",
            message: "private database diagnostic",
            retryable: true,
          }),
      },
    },
    "prepared-hash",
  );
  expect(failed.isErr() && failed.error).toMatchObject({
    type: "preview_error",
    code: "store_unavailable",
    message: "Preview registration unavailable",
  });
});

it("returns configured stable URLs without claiming readiness; disables registration without configuration", async () => {
  const task = new NoSimulationTask("preview registration", false);
  const h = makeHarness();
  seedRunningOrb(task, h, "orb-a");
  const orb = h.store.orbSnapshot("orb-a");
  assert(orb?.runtimeTokenHash);
  const caller = { runtimeTokenHash: orb.runtimeTokenHash, hostIncarnation: orb.hostIncarnation };
  const deps = {
    store: h.store,
    url: (id: string, port: number) => ok(`https://p${port}-o${id}.preview.test`),
    newId: () => "r1",
    reservedPort: 8080,
  };
  const disabled = await exposePreview(
    task,
    { ...deps, url: null },
    { orbId: orb.id, port: 5173, caller },
  );
  expect(disabled.isErr() && disabled.error.code).toBe("preview_disabled");
  expect((await exposePreview(task, deps, { orbId: orb.id, port: 8080, caller })).isErr()).toBe(
    true,
  );
  const result = (
    await exposePreview(task, deps, { orbId: orb.id, port: 5173, caller })
  )._unsafeUnwrap();
  expect(result).toEqual({
    port: 5173,
    registrationId: "r1",
    url: "https://p5173-oorb-a.preview.test",
  });
  expect(
    (await listRegisteredPreviews(task, deps, { orbId: orb.id, caller }))._unsafeUnwrap(),
  ).toEqual([result]);
  expect((await unexposePreview(task, deps, { orbId: orb.id, port: 5173, caller })).isOk()).toBe(
    true,
  );
});
