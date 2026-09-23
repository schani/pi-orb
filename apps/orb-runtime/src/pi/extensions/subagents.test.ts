import { beforeEach, describe, expect, it, vi } from "vitest";

const upstream = vi.hoisted(() => ({
  options: undefined as { shouldWake: (record: { id: string }) => boolean } | undefined,
}));

vi.mock("@gotgenes/pi-subagents/extension", () => ({
  default: (_pi: unknown, options: { shouldWake: (record: { id: string }) => boolean }) => {
    upstream.options = options;
  },
}));
vi.mock("@gotgenes/pi-subagents", () => ({ getSubagentsService: () => undefined }));

import { ok } from "neverthrow";
import { createSubagentsExtension, type SubagentHost } from "./subagents.ts";

type Handler = (data: unknown) => void;

function fixture() {
  const eventHandlers = new Map<string, Handler>();
  const lifecycleHandlers = new Map<string, ((event?: unknown, context?: unknown) => unknown)[]>();
  const entries: { customType: string; data: unknown }[] = [];
  const released: string[] = [];
  let wakeAllowed = true;
  const host: SubagentHost = {
    admitSubagent: (childId) => ok({ childId, operationId: "op" }),
    startSubagent: () => undefined,
    abortOperation: () => Promise.resolve(ok(undefined)),
    releaseSubagent: (run) => released.push(run.childId),
    mayWakeSubagent: () => wakeAllowed,
    bindSubagentAbort: () => undefined,
    subagentAdapterFailed: () => undefined,
  };
  const pi = {
    events: {
      on: (name: string, handler: Handler) => {
        eventHandlers.set(name, handler);
        return () => eventHandlers.delete(name);
      },
    },
    on: (name: string, handler: (event?: unknown, context?: unknown) => unknown) => {
      lifecycleHandlers.set(name, [...(lifecycleHandlers.get(name) ?? []), handler]);
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
  };
  createSubagentsExtension(host, "/test")(pi as never);
  const emit = (event: string, data: unknown) => eventHandlers.get(`subagents:${event}`)?.(data);
  const terminalCount = () =>
    entries.filter(
      (entry) =>
        entry.customType === "pi-orb.subagent-run" &&
        (entry.data as { phase?: string }).phase === "terminal",
    ).length;
  return {
    emit,
    entries,
    released,
    terminalCount,
    shouldWake: (id: string) => upstream.options?.shouldWake({ id }),
    setWakeAllowed: (allowed: boolean) => {
      wakeAllowed = allowed;
    },
  };
}

beforeEach(() => {
  upstream.options = undefined;
});

describe("subagent terminal ownership", () => {
  it("releases foreground and claimed outcomes even when no automatic wake is considered", async () => {
    const h = fixture();
    h.emit("created", { id: "child" });
    h.emit("completed", { id: "child" });
    await Promise.resolve();
    expect(h.released).toEqual(["child"]);
    expect(h.terminalCount()).toBe(1);
  });

  it("does not make cleanup depend on a queued wake that is skipped after its permission check", async () => {
    const h = fixture();
    h.emit("created", { id: "child" });
    h.emit("completed", { id: "child" });
    expect(h.shouldWake("child")).toBe(true);
    await Promise.resolve();
    expect(h.released).toEqual(["child"]);
  });

  it("releases ownership when cancellation follows wake permission but precedes continuation start", async () => {
    const h = fixture();
    h.emit("created", { id: "child" });
    h.emit("completed", { id: "child" });
    expect(h.shouldWake("child")).toBe(true);
    h.setWakeAllowed(false);
    await Promise.resolve();
    expect(h.released).toEqual(["child"]);
  });

  it("records one terminal edge when a suppressed wake is checked synchronously", async () => {
    const h = fixture();
    h.emit("created", { id: "child" });
    h.emit("completed", { id: "child" });
    h.setWakeAllowed(false);
    expect(h.shouldWake("child")).toBe(false);
    await Promise.resolve();
    expect(h.released).toEqual(["child"]);
    expect(h.terminalCount()).toBe(1);
  });
});
