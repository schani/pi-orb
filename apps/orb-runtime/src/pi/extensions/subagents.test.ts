import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const upstream = vi.hoisted(() => ({
  options: undefined as
    | { shouldWake: (record: { id: string }) => boolean; childExtensions: InlineExtension[] }
    | undefined,
}));

vi.mock("@gotgenes/pi-subagents/extension", () => ({
  default: (
    _pi: unknown,
    options: {
      shouldWake: (record: { id: string }) => boolean;
      childExtensions: InlineExtension[];
    },
  ) => {
    upstream.options = options;
  },
}));
vi.mock("@gotgenes/pi-subagents", () => ({ getSubagentsService: () => undefined }));

import { ok } from "neverthrow";
import { StreamTelemetry } from "../stream-telemetry.ts";
import { createOrbExtensions } from "./index.ts";
import { createSubagentsExtension, type SubagentHost } from "./subagents.ts";

it("inherits isolated stream observers into native children", () => {
  const telemetry = new StreamTelemetry(() => 100);
  const root = createOrbExtensions({
    cwd: "/test",
    subagents: {} as SubagentHost,
    streams: {
      telemetry,
      operationId: () => "op",
      rootSessionId: () => "root",
      audit: () => ok(undefined),
      failed: () => expect.fail("audit failed"),
    },
  });
  const named = (extensions: InlineExtension[], name: string) => {
    const extension = extensions.find((item) => typeof item !== "function" && item.name === name);
    if (!extension || typeof extension === "function") throw new Error(`missing ${name}`);
    return extension.factory;
  };
  named(root, "pi-orb:subagents")({ on: () => {}, events: { on: () => () => {} } } as never);
  if (!upstream.options) throw new Error("missing child extensions");
  const child = upstream.options.childExtensions;
  const invoke = (extensions: InlineExtension[], id: string) => {
    const handlers = new Map<string, (event: never, context: never) => void>();
    named(
      extensions,
      "pi-orb:stream-telemetry",
    )({
      on: (name: string, handler: (event: never, context: never) => void) =>
        handlers.set(name, handler),
    } as never);
    handlers.get("before_provider_request")?.(
      {} as never,
      { sessionManager: { getSessionId: () => id } } as never,
    );
  };
  invoke(root, "root");
  invoke(child, "child");
  expect(telemetry.snapshot()).toMatchObject([
    { sessionId: "root" },
    { sessionId: "child", parentSessionId: "root" },
  ]);
  expect(telemetry.snapshot()[0]).not.toHaveProperty("parentSessionId");
});

type Handler = (data: unknown) => void;

function fixture(childExtensions: InlineExtension[] = []) {
  const eventHandlers = new Map<string, Handler>();
  const lifecycleHandlers = new Map<string, ((event?: unknown, context?: unknown) => unknown)[]>();
  const entries: { customType: string; data: unknown }[] = [];
  const released: string[] = [];
  const abortSources: (string | undefined)[] = [];
  let wakeAllowed = true;
  const host: SubagentHost = {
    admitSubagent: (childId) => ok({ childId, operationId: "op" }),
    startSubagent: () => undefined,
    abortOperation: (source) => {
      abortSources.push(source);
      return Promise.resolve(ok(undefined));
    },
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
  createSubagentsExtension(host, "/test", childExtensions)(pi as never);
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
    abortSources,
    shutdown: async () => {
      for (const handler of lifecycleHandlers.get("session_shutdown") ?? []) await handler();
    },
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
  it("passes child session factories without inheriting the parent extension or borrowing its owner", () => {
    const childFactory = vi.fn();
    const childExtensions: InlineExtension[] = [
      { name: "pi-orb:mcp", factory: childFactory },
      { name: "pi-orb:codemode", factory: vi.fn() },
    ];
    fixture(childExtensions);
    expect(upstream.options?.childExtensions).toBe(childExtensions);
    expect(upstream.options?.childExtensions.map(({ name }) => name)).toEqual([
      "pi-orb:mcp",
      "pi-orb:codemode",
    ]);
    expect(childFactory).not.toHaveBeenCalled();
  });

  it("passes shutdown provenance to abort and waits for child cleanup", async () => {
    const h = fixture();
    h.emit("created", { id: "child" });
    let finished = false;
    const shutdown = h.shutdown().then(() => {
      finished = true;
    });
    expect(h.abortSources).toEqual(["shutdown"]);
    // Checkpoint through the resolved abort and both shutdown hooks before
    // releasing the child; without a drain wait, the observer has run by then.
    for (let step = 0; step < 5; step++) await Promise.resolve();
    expect(finished).toBe(false);
    expect(h.released).toEqual([]);
    h.emit("completed", { id: "child" });
    await shutdown;
    expect(finished).toBe(true);
    expect(h.released).toEqual(["child"]);
    expect(h.terminalCount()).toBe(1);
  });

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
