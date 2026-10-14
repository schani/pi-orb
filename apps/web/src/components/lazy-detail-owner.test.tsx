import type { CommittedDisplayDetail, LiveDisplayDetail } from "@pi-orb/protocol";
import { ok } from "neverthrow";
import { beforeEach, expect, it, vi } from "vitest";
import {
  snapshotFromHistory,
  TranscriptCache,
  type TranscriptOwner,
} from "../lib/transcript-cache.ts";
import { history } from "../testkit/transcript.ts";
import { CommittedImage } from "./CommittedImage.tsx";
import { CommittedBody, type DetailContext, RunningBody } from "./DetailBody.tsx";

// Execute passive effects with dependency tracking, without a browser/server.
const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { deps?: unknown[]; cleanup?: (() => void) | undefined; value?: unknown }[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: (factory: () => unknown, deps: unknown[]) => {
    const index = hooks.cursor++;
    const slot = hooks.slots[index];
    if (!slot?.deps || deps.some((dep, i) => !Object.is(dep, slot.deps?.[i])))
      hooks.slots[index] = { deps, value: factory() };
    return hooks.slots[index]?.value;
  },
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    hooks.slots[index] ??= { value: initial };
    const slot = hooks.slots[index];
    return [
      slot.value,
      (value: unknown) => {
        slot.value = value;
      },
    ];
  },
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    const index = hooks.cursor++;
    hooks.slots[index] ??= {};
    const slot = hooks.slots[index];
    if (slot.deps && deps.every((dep, i) => Object.is(dep, slot.deps?.[i]))) return;
    slot.cleanup?.();
    slot.deps = deps;
    slot.cleanup = effect();
  },
}));
vi.mock("../lib/api.ts", () => ({
  getLiveDetail: vi.fn(),
  getCommittedDetail: vi.fn(),
  getCommittedImage: vi.fn(),
  describeApiError: vi.fn((error: { message: string }) => error.message),
}));
vi.mock("../lib/object-url.ts", () => ({
  createImageObjectUrl: vi.fn(() => ok("blob:test")),
  revokeImageObjectUrl: vi.fn(() => ok(undefined)),
}));

import { getCommittedDetail, getCommittedImage, getLiveDetail } from "../lib/api.ts";
import { createImageObjectUrl } from "../lib/object-url.ts";

beforeEach(() => {
  for (const slot of hooks.slots) slot.cleanup?.();
  hooks.slots = [];
  hooks.cursor = 0;
  vi.clearAllMocks();
  vi.mocked(getLiveDetail).mockReset();
  vi.mocked(getCommittedDetail).mockReset();
  vi.mocked(getCommittedImage).mockReset();
});
function fixture() {
  const cache = new TranscriptCache();
  const snapshot = snapshotFromHistory(history());
  const initialOwner = cache.acquire("orb", "project");
  let owner: TranscriptOwner | null = initialOwner;
  initialOwner.publish(snapshot);
  const detail: CommittedDisplayDetail = {
    v: 1,
    state: "committed",
    sessionId: snapshot.sessionId ?? "session",
    recordId: "one",
    detailKey: "one:0",
    body: { type: "reasoning", text: "cached detail" },
  };
  const context: DetailContext = {
    orbId: "orb",
    sessionId: snapshot.sessionId,
    connected: false,
    operationId: null,
    cache,
    getOwner: () => owner,
    livePending: new Map(),
    committedPending: new Map(),
    imagePending: new Map(),
  };
  return {
    context,
    detail,
    owner: () => initialOwner,
    release: () => {
      owner?.release();
      owner = null;
    },
    acquire: () => {
      owner = cache.acquire("orb", "project");
      context.getOwner = () => owner;
    },
  };
}
function mount(context: DetailContext, image: boolean) {
  hooks.cursor = 0;
  return image
    ? CommittedImage({ context, recordId: "one", detailKey: "one:0", index: 0 })
    : CommittedBody({ context, recordId: "one", detailKey: "one:0" });
}
it("starts only the surviving StrictMode detail effect's request", async () => {
  const f = fixture();
  const owners = new Map<TranscriptOwner, number>();
  const trace: string[] = [];
  const trackOwner = () => {
    const getOwner = f.context.getOwner;
    f.context.getOwner = () => {
      const owner = getOwner();
      if (owner !== null && !owners.has(owner)) owners.set(owner, owners.size + 1);
      trace.push(`owner:${owner === null ? "none" : owners.get(owner)}`);
      return owner;
    };
  };
  vi.mocked(getCommittedDetail).mockImplementation(() => {
    trace.push(`request:${owners.size}`);
    return Promise.resolve(ok(f.detail));
  });
  trackOwner();
  mount(f.context, false);
  for (const slot of hooks.slots) {
    slot.cleanup?.();
    delete slot.deps;
  }
  trace.push("cleanup:1");
  f.release();
  f.acquire();
  trackOwner();
  mount(f.context, false);
  console.info("StrictMode owner/request trace", trace);
  expect(getCommittedDetail, trace.join(" → ")).not.toHaveBeenCalled();
  await flush();
  expect(trace).toEqual(["owner:1", "cleanup:1", "owner:2", "request:2"]);
  expect(getCommittedDetail).toHaveBeenCalledTimes(1);
  expect(f.context.cache.getDetail("orb", f.detail.sessionId, "one", "one:0")?.body).toEqual(
    f.detail.body,
  );
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
it.each([false, true])(
  "defers uncached reads until fresh metadata, then wakes without remount (image=%s)",
  async (image) => {
    const f = fixture();
    f.release();
    vi.mocked(getCommittedDetail).mockReturnValue(Promise.resolve(ok(f.detail)));
    vi.mocked(getCommittedImage).mockReturnValue(Promise.resolve(ok(new Blob(["image"]))));
    mount(f.context, image);
    expect(getCommittedDetail).not.toHaveBeenCalled();
    expect(getCommittedImage).not.toHaveBeenCalled();
    f.acquire();
    mount(f.context, image);
    await flush();
    expect(image ? getCommittedImage : getCommittedDetail).toHaveBeenCalledTimes(1);
    expect(
      image
        ? f.context.cache.getImage("orb", f.detail.sessionId, "one", "one:0", 0)
        : f.context.cache.getDetail("orb", f.detail.sessionId, "one", "one:0"),
    ).toBeDefined();
  },
);
it.each([false, true])(
  "renders immutable cache hits without metadata authority (image=%s)",
  async (image) => {
    const f = fixture();
    f.owner().publishDetail(f.detail);
    f.owner().publishImage({ ...f.detail, imageIndex: 0, blob: new Blob(["cached"]) });
    f.release();
    mount(f.context, image);
    await flush();
    expect(getCommittedDetail).not.toHaveBeenCalled();
    expect(getCommittedImage).not.toHaveBeenCalled();
    if (image) expect(createImageObjectUrl).toHaveBeenCalledTimes(1);
    else
      expect(hooks.slots.some((slot) => JSON.stringify(slot.value).includes("cached detail"))).toBe(
        true,
      );
  },
);
it.each([false, true])(
  "does not reuse or publish an old owner's pending response (image=%s)",
  async (image) => {
    const f = fixture();
    let finish!: (value: never) => void;
    const pending = new Promise<never>((resolve) => {
      finish = resolve;
    });
    vi.mocked(getCommittedDetail)
      .mockReturnValueOnce(pending)
      .mockReturnValue(Promise.resolve(ok(f.detail)));
    vi.mocked(getCommittedImage)
      .mockReturnValueOnce(pending)
      .mockReturnValue(Promise.resolve(ok(new Blob(["new"]))));
    mount(f.context, image);
    await flush();
    for (const slot of hooks.slots) slot.cleanup?.();
    hooks.slots = [];
    f.release();
    f.acquire();
    mount(f.context, image);
    await flush();
    expect(image ? getCommittedImage : getCommittedDetail).toHaveBeenCalledTimes(2);
    finish(
      ok(
        image ? new Blob(["old"]) : { ...f.detail, body: { type: "reasoning", text: "old" } },
      ) as never,
    );
    await flush();
    if (image)
      expect(
        await f.context.cache.getImage("orb", f.detail.sessionId, "one", "one:0", 0)?.text(),
      ).toBe("new");
    else
      expect(f.context.cache.getDetail("orb", f.detail.sessionId, "one", "one:0")?.body).toEqual(
        f.detail.body,
      );
  },
);

it.each([false, true])("starts cold owned reads before the next task (image=%s)", async (image) => {
  const f = fixture();
  vi.mocked(getCommittedDetail).mockReturnValue(Promise.resolve(ok(f.detail)));
  vi.mocked(getCommittedImage).mockReturnValue(Promise.resolve(ok(new Blob(["cold"]))));
  mount(f.context, image);
  await flush();
  expect(image ? getCommittedImage : getCommittedDetail).toHaveBeenCalledTimes(1);
  if (image) expect(createImageObjectUrl).toHaveBeenCalledTimes(1);
  else
    expect(hooks.slots.some((slot) => JSON.stringify(slot.value).includes("cached detail"))).toBe(
      true,
    );
});
it.each([false, true])("invalidation fences pending publication (image=%s)", async (image) => {
  const f = fixture();
  let finish!: (value: never) => void;
  const pending = new Promise<never>((resolve) => {
    finish = resolve;
  });
  vi.mocked(getCommittedDetail).mockReturnValue(pending);
  vi.mocked(getCommittedImage).mockReturnValue(pending);
  mount(f.context, image);
  await flush();
  f.context.cache.invalidate("orb");
  finish(ok(image ? new Blob(["late"]) : f.detail) as never);
  await flush();
  expect(createImageObjectUrl).not.toHaveBeenCalled();
  expect(f.context.cache.get("orb")).toBeUndefined();
  expect(hooks.slots.some((slot) => JSON.stringify(slot.value)?.includes("cached detail"))).toBe(
    false,
  );
});

// Narrow hook wiring/state checks, not ReactDOM scheduling qualification.
it.each([false, true])("live identities (newFirst=%s)", async (newFirst) => {
  const f = fixture();
  const cases = [
    ["orb", "session", "operation", "block", "baseline body"],
    ["other-orb", "session", "operation", "block", "other orb body"],
    ["orb", "other-session", "operation", "block", "other session body"],
    ["orb", "session", "other-operation", "block", "other operation body"],
    ["orb", "session", "operation", "other-block", "current block body"],
  ] as const;
  const finish: (() => void)[] = [];
  const render = (context: DetailContext, blockId: string) => {
    hooks.cursor = 0;
    return RunningBody({ context, blockId });
  };
  try {
    for (const [orbId, sessionId, operationId, blockId, text] of cases) {
      const detail: LiveDisplayDetail = {
        v: 1,
        sessionId,
        operationId,
        blockId,
        state: "completed",
        body: { type: "reasoning", text },
      };
      vi.mocked(getLiveDetail).mockReturnValueOnce(
        new Promise((resolve) => finish.push(() => resolve(ok(detail)))),
      );
      f.context = { ...f.context, orbId, sessionId, operationId, connected: true };
      render(f.context, blockId);
      if (text === "baseline body") {
        for (const slot of hooks.slots.splice(0)) slot.cleanup?.();
        render(f.context, blockId); // Same identity remount must reuse the pending HTTP read.
        expect(getLiveDetail).toHaveBeenCalledTimes(1);
      }
    }
    expect(vi.mocked(getLiveDetail).mock.calls).toEqual(
      cases.map(([orb, session, operation, block]) => [orb, operation, block, session]),
    );
    expect(getLiveDetail).toHaveBeenCalledTimes(5);
    for (const index of newFirst ? [4, 3, 2, 1, 0] : [0, 1, 2, 3, 4]) {
      finish[index]?.();
      await flush();
      const currentReady = newFirst || index === 4;
      expect(render(f.context, "other-block").props.children).toBe(
        currentReady ? "current block body" : "",
      );
      if (!currentReady) expect(hooks.slots[0]?.value).toBeUndefined();
    }
    expect(f.context.livePending.size).toBe(0);
  } finally {
    for (const slot of hooks.slots) slot.cleanup?.();
    for (const settle of finish) settle();
    await flush();
    f.release();
  }
});

it.each([false, true])("session ownership (newFirst=%s)", async (newFirst) => {
  const f = fixture();
  const finish: (() => void)[] = [];
  const next: CommittedDisplayDetail = {
    ...f.detail,
    sessionId: "replacement-session",
    body: { type: "reasoning", text: "replacement body" },
  };
  try {
    for (const detail of [f.detail, next])
      vi.mocked(getCommittedDetail).mockReturnValueOnce(
        new Promise((resolve) => finish.push(() => resolve(ok(detail)))),
      );
    mount(f.context, false);
    await flush();
    f.owner().publish(snapshotFromHistory(history("orb", ["one"], "replacement-session")));
    f.context = { ...f.context, sessionId: "replacement-session" };
    mount(f.context, false);
    await flush();
    expect(vi.mocked(getCommittedDetail).mock.calls).toEqual([
      ["orb", "one", "one:0", "session"],
      ["orb", "one", "one:0", "replacement-session"],
    ]);
    for (const index of newFirst ? [1, 0] : [0, 1]) {
      finish[index]?.();
      await flush();
      expect(mount(f.context, false).props.children).toEqual(
        newFirst || index === 1
          ? expect.objectContaining({ props: expect.objectContaining({ body: next.body }) })
          : "Loading…",
      );
      expect(hooks.slots[1]?.value).toEqual(
        newFirst || index === 1 ? expect.objectContaining({ value: next.body }) : null,
      );
      expect(f.context.cache.getDetail("orb", "session", "one", "one:0")).toBeUndefined();
    }
    expect(f.context.cache.getDetail("orb", "replacement-session", "one", "one:0")?.body).toEqual(
      next.body,
    );
  } finally {
    for (const slot of hooks.slots) slot.cleanup?.();
    for (const settle of finish) settle();
    await flush();
    f.release();
  }
});
