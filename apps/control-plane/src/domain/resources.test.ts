import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import {
  ResourceAcquisition,
  type ResourceSnapshot,
  type ResourceSnapshotStore,
  type ResourceStatus,
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

it("bounds first-party messages to 1536 and strips control characters", () => {
  const failure = resourceError(
    "invalid",
    `Invalid\nresource\r\t\0\x1b\x7f\x85\u2028\u202e: ${"p".repeat(2000)}`,
  );
  expect(failure.message).toHaveLength(1536);
  expect(failure.message).toBe(`Invalidresource: ${"p".repeat(1519)}`);
  expect(resourceError("invalid", "\n\0").message).toBe("Required resource snapshot unavailable");
});

it.each([false, true])(
  "publishes ready warnings (present: %s) without reacquisition",
  async (present) => {
    const warnings = [{ path: ".agents/skills/bad/SKILL.md", code: "invalid_yaml" as const }];
    const value: ResourceSnapshot = { ...snapshot, ...(present ? { warnings } : {}) };
    const source = { acquire: vi.fn(() => okAsync(value)) };
    const record = vi.fn((_orbId: string, _status: ResourceStatus) => okAsync(undefined));
    const store: ResourceSnapshotStore = {
      get: () => okAsync(value),
      put: (value) => okAsync(value),
      remove: () => okAsync(undefined),
    };
    const result = await new ResourceAcquisition(store, source, { record }).acquire({
      orbId: "orb",
      url: "https://example.invalid/repo",
      signal: new AbortController().signal,
    });
    expect(result._unsafeUnwrap()).toBe(value);
    expect(source.acquire).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledExactlyOnceWith("orb", {
      phase: "ready",
      commitSha: value.commitSha,
      fileCount: 1,
      byteCount: Buffer.byteLength("instruction"),
      warnings: present ? warnings : [],
    });
  },
);

it("publishes adapter-owned failure messages without changing returned errors", async () => {
  const message = "Required instruction resource missing: AGENTS.md";
  const error = { ...resourceError("invalid", message) };
  const acquire = vi.fn(() => errAsync(error));
  const put = vi.fn((value: ResourceSnapshot) => okAsync(value));
  const record = vi.fn((_orbId: string, _status: ResourceStatus) => okAsync(undefined));
  const store: ResourceSnapshotStore = {
    get: () => okAsync(null),
    put,
    remove: () => okAsync(undefined),
  };
  const result = await new ResourceAcquisition(store, { acquire }, { record }).acquire({
    orbId: "orb",
    url: "https://example.invalid/repo",
    signal: new AbortController().signal,
  });
  expect(result._unsafeUnwrapErr()).toBe(error);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(put).not.toHaveBeenCalled();
  expect(record.mock.calls.map(([, status]) => status)).toEqual([
    { phase: "acquiring" },
    {
      phase: "failed",
      code: "invalid",
      message,
    },
  ]);
});
