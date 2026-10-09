import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { afterEach, expect, it, vi } from "vitest";
import type { UploadRow } from "../domain/workspace-uploads.ts";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import { uploadRequest } from "./workspace-upload-http.ts";

afterEach(() => vi.unstubAllGlobals());
it("forwards scoped execution bearer and rejects a stale binding before upload", async () => {
  const task = new NoSimulationTask("upload fence", false);
  const harness = makeHarness();
  seedRunningOrb(task, harness, "upload-orb");
  const orb = harness.store.orbSnapshot("upload-orb");
  if (!orb?.hostRef) throw new Error("fixture missing orb host");
  const observed = await harness.deps.hostProvider.observe(
    task,
    { provider: harness.deps.hostProvider.kind, resourceId: orb.hostRef },
    { signal: new AbortController().signal },
  );
  if (observed.isErr() || !observed.value?.runtimeAddress)
    throw new Error("fixture missing endpoint");
  const binding = {
    baseUrl: observed.value.runtimeAddress.baseUrl,
    token: "upload-secret",
    incarnation: "0",
    cwd: "/workspace",
  };
  harness.deps.hostProvider.executionBinding = () => okAsync(binding);
  const fetched = vi.fn(
    async () =>
      new Response(JSON.stringify({ offset: 0, path: null, sha256: null }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetched);
  const row: UploadRow = {
    orbId: orb.id,
    incarnation: 0,
    activeUntil: 0,
    id: "upload",
    batchId: "batch",
    name: "a.txt",
    size: 2,
    offset: 0,
    path: null,
    sha256: null,
    status: "transferring",
    error: null,
  };
  expect((await uploadRequest(task, harness.deps, row, "status")).isOk()).toBe(true);
  expect(fetched).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      headers: expect.objectContaining({
        authorization: "Bearer upload-secret",
        "x-orb-incarnation": "0",
      }),
    }),
  );
  harness.deps.hostProvider.executionBinding = () => okAsync({ ...binding, incarnation: "1" });
  expect((await uploadRequest(task, harness.deps, row, "status")).isErr()).toBe(true);
  expect(fetched).toHaveBeenCalledTimes(1);
});
