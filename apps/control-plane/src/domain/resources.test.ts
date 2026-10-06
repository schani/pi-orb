import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import {
  ResourceAcquisition,
  type ResourceSnapshot,
  type ResourceSnapshotStore,
  readResource,
  resourceError,
} from "./resources.ts";

const snapshot: ResourceSnapshot = {
  orbId: "orb",
  commitSha: "a".repeat(40),
  instructionPath: "AGENTS.md",
  skillRoot: null,
  files: [{ path: "AGENTS.md", bytes: Buffer.from("instruction"), sha256: "hash" }],
};
it("restores offline without calling source and exposes only adopted paths", async () => {
  const source = { acquire: vi.fn(() => errAsync(resourceError("fetch", "offline"))) };
  const store: ResourceSnapshotStore = {
    get: () => okAsync(snapshot),
    put: (value) => okAsync(value),
    remove: () => okAsync(undefined),
  };
  const r = await new ResourceAcquisition(store, source).acquire({
    orbId: "orb",
    url: "https://example.invalid/repo",
    signal: new AbortController().signal,
  });
  expect(r.isOk()).toBe(true);
  expect(source.acquire).not.toHaveBeenCalled();
  expect((await readResource(snapshot, "../private")).isErr()).toBe(true);
  const bytes = (await readResource(snapshot, "AGENTS.md"))._unsafeUnwrap();
  bytes[0] = 0;
  expect(Buffer.from(snapshot.files[0]?.bytes ?? []).toString()).toBe("instruction");
});
it("does not publish after cancellation while acquisition is held", async () => {
  let release: (value: ResourceSnapshot) => void = () => undefined;
  const held = new Promise<ResourceSnapshot>((resolve) => {
    release = resolve;
  });
  const put = vi.fn((value: ResourceSnapshot) => okAsync(value));
  const store: ResourceSnapshotStore = {
    get: () => okAsync(null),
    put,
    remove: () => okAsync(undefined),
  };
  const controller = new AbortController();
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const result = new ResourceAcquisition(
    store,
    {
      acquire: () => {
        enter();
        return ResultAsync.fromPromise(held, () => resourceError("fetch", "failed"));
      },
    },
    {
      record: (_orbId, status) => {
        if (status.phase === "failed") finish();
        return okAsync(undefined);
      },
    },
  ).acquire({ orbId: "orb", url: "https://example.invalid/repo", signal: controller.signal });
  await entered;
  controller.abort();
  expect((await result).isErr()).toBe(true);
  release(snapshot);
  await finished;
  expect(put).not.toHaveBeenCalled();
});
