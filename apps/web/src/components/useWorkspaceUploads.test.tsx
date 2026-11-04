import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetBrowserSessionForTest } from "../lib/session.ts";
import { useWorkspaceUploads } from "./useWorkspaceUploads.tsx";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: (() => void) | undefined }[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (value: unknown) => {
    const index = hooks.cursor++;
    hooks.slots[index] ??= { value: { current: value } };
    return hooks.slots[index]?.value;
  },
  useState: (value: unknown) => {
    const index = hooks.cursor++;
    hooks.slots[index] ??= { value };
    const slot = hooks.slots[index];
    return [
      slot.value,
      (next: unknown) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
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
function render(available = true) {
  hooks.cursor = 0;
  // biome-ignore lint/correctness/useHookAtTopLevel: deterministic effect harness owns hook order.
  return useWorkspaceUploads("orb", false, available);
}
function unmount() {
  for (const slot of hooks.slots) slot.cleanup?.();
}
beforeEach(() => {
  hooks.cursor = 0;
  hooks.slots = [];
  resetBrowserSessionForTest();
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["missing", "unmount"] as const)(
  "aborts a held listing on %s and never schedules a later poll",
  async (exit) => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(
      (_path: string, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    render();
    expect(fetch).toHaveBeenCalledOnce();
    const signal = fetch.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    if (exit === "missing") render(false);
    else unmount();
    try {
      expect(signal?.aborted).toBe(true);
    } finally {
      finish(new Response("[]"));
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("clears a scheduled poll when the resource becomes missing", async () => {
  const fetch = vi.fn(async () => new Response("[]"));
  vi.stubGlobal("fetch", fetch);
  render();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
  render(false);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not start a listing for a confirmed missing resource", async () => {
  const fetch = vi.fn(async () => new Response("[]"));
  vi.stubGlobal("fetch", fetch);
  render(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetch).not.toHaveBeenCalled();
});
it("continues listing transfers for an existing stopped orb", async () => {
  const row = {
    id: "11111111-1111-4111-8111-111111111111",
    batchId: "11111111-1111-4111-8111-111111111111",
    name: "file.txt",
    size: 10,
    offset: 10,
    path: "/workspace/uploads/file.txt",
    sha256: null,
    status: "stored",
    error: null,
  };
  const fetch = vi.fn(async () => new Response(JSON.stringify([row])));
  vi.stubGlobal("fetch", fetch);
  render();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledOnce();
  const uploads = render();
  expect(renderToStaticMarkup(uploads.button)).toBe("");
  expect(renderToStaticMarkup(uploads.progress)).toContain("/workspace/uploads/file.txt");
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetch).toHaveBeenCalledTimes(2);
});
