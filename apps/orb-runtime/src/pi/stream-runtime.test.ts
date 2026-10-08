import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ServerFrame } from "@pi-orb/protocol";
import { err, type Result } from "neverthrow";
import { expect, it, vi } from "vitest";
import { MemoryIdleStopFence } from "../testkit/idle-stop-fence.ts";
import { PiOrbAgent, type PiSession } from "./agent.ts";
import { createPersistentSession } from "./settings-persistence.ts";
import type { StreamAudit, StreamTelemetry } from "./stream-telemetry.ts";

it.each(["append", "fsync", "publication"] as const)(
  "audit %s failure degrades diagnostics once without blocking healthy runtime authority",
  async (failure) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "stream-runtime-failure-"));
    try {
      const manager = createPersistentSession(dir, join(dir, "sessions"))._unsafeUnwrap();
      const file = manager.getSessionFile();
      if (!file) throw new Error("missing session file");
      const agent = new PiOrbAgent({
        orbId: "orb",
        repositoryUrl: "https://example.com/repo",
        workDir: dir,
        skillsDir: null,
        broker: null,
        executionId: "execution",
        idleStopFence: new MemoryIdleStopFence(),
      });
      let listener: ((event: AgentSessionEvent) => void) | undefined;
      agent.attachSession(
        {
          isIdle: false,
          pendingMessageCount: 0,
          subscribe: (handler: (event: AgentSessionEvent) => void) => {
            listener = handler;
            return () => {};
          },
          sendCustomMessage: async () => {},
        } as unknown as PiSession,
        manager,
        {
          summarize: () => {
            throw new Error("unexpected summary");
          },
        },
      );
      listener?.({ type: "agent_start" });
      const seam = agent as unknown as {
        streamTelemetry: StreamTelemetry;
        persistStreamAudit(edge: StreamAudit): Result<void, { type: "stream_audit_failed" }>;
        streamAuditFailed(): void;
        liveHistory: { flushPersisted(): Result<void, { message: string }> };
      };
      const request = seam.streamTelemetry.start({
        requestId: "local",
        operationId: "op",
        sessionId: "root",
        attempt: 1,
      });
      seam.streamTelemetry.providerEvent(request, {
        type: "response.function_call_arguments.delta",
        delta: "x".repeat(65_536),
      });
      const edge = seam.streamTelemetry.poll()[0];
      if (!edge) throw new Error("missing audit");
      const savedFile = readFileSync(file);
      const append = manager.appendCustomEntry.bind(manager);
      const getFile = manager.getSessionFile.bind(manager);
      const flush = seam.liveHistory.flushPersisted.bind(seam.liveHistory);
      if (failure === "append")
        manager.appendCustomEntry = () => {
          throw new Error("SECRET adapter failure");
        };
      else if (failure === "fsync")
        manager.getSessionFile = () => {
          unlinkSync(file);
          return file;
        };
      else seam.liveHistory.flushPersisted = () => err({ message: "SECRET publication failure" });
      const frames: ServerFrame[] = [];
      agent.subscribe((frame) => frames.push(frame));
      expect(seam.persistStreamAudit(edge)._unsafeUnwrapErr()).toEqual({
        type: "stream_audit_failed",
      });
      seam.streamAuditFailed();
      manager.appendCustomEntry = append;
      manager.getSessionFile = getFile;
      seam.liveHistory.flushPersisted = flush;
      if (failure === "fsync") writeFileSync(file, savedFile);
      const entries = manager.getEntries().length;
      expect(seam.persistStreamAudit(edge).isErr()).toBe(true);
      seam.streamAuditFailed();
      expect(manager.getEntries()).toHaveLength(entries);
      expect(log).toHaveBeenCalledTimes(1);
      expect(frames.filter((frame) => frame.type === "server.error")).toHaveLength(1);
      expect(JSON.stringify(frames)).not.toContain("SECRET");
      expect(agent.getHealth()).toMatchObject({
        status: "ready",
        activity: "busy",
        streamTelemetryError: "persistence_failed",
        streams: [{ requestId: "local", toolArgumentBytes: 65_536 }],
      });
      expect(agent.snapshot().isOk()).toBe(true);
      expect(
        (
          await agent.deliverInboxMessage("inbox", ["inbox"], [{ type: "text", text: "input" }])
        ).isOk(),
      ).toBe(true);
      expect(agent.snapshot().isOk()).toBe(true);
    } finally {
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it("ready health and durable root history retain child counters but no generated contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "stream-runtime-"));
  try {
    const manager = createPersistentSession(dir, join(dir, "sessions"))._unsafeUnwrap();
    const file = manager.getSessionFile();
    if (!file) throw new Error("missing session file");
    const agent = new PiOrbAgent({
      orbId: "orb",
      repositoryUrl: "https://example.com/repo",
      workDir: dir,
      skillsDir: null,
      broker: null,
      executionId: "execution",
      idleStopFence: new MemoryIdleStopFence(),
    });
    agent.attachSession(
      { isIdle: true, pendingMessageCount: 0, subscribe: () => () => {} } as unknown as PiSession,
      manager,
      {
        summarize: () => {
          throw new Error("unexpected summary");
        },
      },
    );
    const seam = agent as unknown as {
      streamTelemetry: StreamTelemetry;
      persistStreamAudit(edge: StreamAudit): Result<void, { type: "stream_audit_failed" }>;
    };
    const request = seam.streamTelemetry.start({
      requestId: "local",
      operationId: "op",
      sessionId: "child",
      parentSessionId: manager.getSessionId(),
      attempt: 1,
    });
    seam.streamTelemetry.providerEvent(request, {
      type: "response.function_call_arguments.delta",
      delta: "x".repeat(1_048_576),
      prompt: "SECRET",
    });
    expect(agent.getHealth()).toMatchObject({
      status: "ready",
      streams: [{ requestId: "local", toolArgumentBytes: 1_048_576 }],
    });
    const frames: ServerFrame[] = [];
    agent.subscribe((frame) => frames.push(frame));
    for (const edge of seam.streamTelemetry.poll())
      expect(seam.persistStreamAudit(edge).isOk()).toBe(true);
    const terminal = seam.streamTelemetry.finish(request, "aborted");
    if (!terminal) throw new Error("missing terminal audit");
    expect(seam.persistStreamAudit(terminal).isOk()).toBe(true);
    const persisted = SessionManager.open(file)
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "pi-orb.stream-audit");
    expect(persisted).toHaveLength(2);
    expect(persisted).toMatchObject([
      { data: { edge: "large_tool_arguments", sessionId: "child" } },
      { data: { edge: "terminal", terminal: "aborted" } },
    ]);
    expect(JSON.stringify(persisted)).not.toContain("SECRET");
    expect(frames).toContainEqual(
      expect.objectContaining({
        record: expect.objectContaining({
          eventType: "agent.stream_issue",
          custom: { customType: "pi-orb.stream-audit", display: true },
        }),
      }),
    );
    expect(agent.getHealth()).not.toHaveProperty("streams");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
