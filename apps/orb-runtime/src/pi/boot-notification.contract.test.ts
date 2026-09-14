import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { okAsync } from "neverthrow";
import { afterEach, expect, it } from "vitest";
import { PiOrbAgent, type PiSession } from "./agent.ts";
import { BOOT_BASELINE_TYPE, planBootNotification } from "./boot-notification.ts";
import { interruptedSubagents } from "./subagent-recovery.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-boot-contract-"));
  roots.push(root);
  const manager = SessionManager.create(root, root);
  manager.appendCustomEntry(BOOT_BASELINE_TYPE, {
    runtimeInstanceId: "before",
    executionId: "old-host",
    incarnation: "0",
  });
  manager.appendMessage({ role: "user", content: "do work", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stopReason: "stop",
    api: "openai-responses",
    provider: "openai-codex",
    model: "test",
    timestamp: 2,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const agent = new PiOrbAgent({
    skillsDir: null,
    orbId: "boot-test",
    repositoryUrl: "https://example.com/repo",
    workDir: root,
    broker: null,
    executionId: "new-host",
  });
  return { agent, manager, root };
}

it("persists a visible, model-visible user-role notice and deduplicates after reopen", () => {
  const { agent, manager, root } = fixture();
  let turns = 0;
  const pi: PiSession = {
    isIdle: true,
    sendUserMessage: async () => undefined,
    abort: async () => undefined,
    abortBash: () => undefined,
    executeBash: async () => {
      throw new Error("unexpected shell");
    },
    subscribe: () => () => undefined,
    sendCustomMessage: (message, options) => {
      manager.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details,
      );
      if (options?.triggerTurn) turns++;
      // Intentionally unresolved: readiness must not wait for inference.
      return new Promise<void>(() => undefined);
    },
  };
  agent.attachSession(pi, manager, { summarize: () => okAsync("") });
  expect(agent.getHealth()).toMatchObject({
    status: "ready",
    activity: "busy",
    turnResume: { outcome: "notified_restart" },
  });
  expect(turns).toBe(1);
  const reopened = SessionManager.open(manager.getSessionFile() ?? "", root, root);
  const entry = reopened.getEntries().at(-1);
  expect(entry).toMatchObject({
    type: "custom_message",
    customType: "pi-orb.host-restarted",
    display: true,
  });
  const messages = convertToLlm(reopened.buildSessionContext().messages);
  expect(messages.at(-1)).toMatchObject({
    role: "user",
    content: [
      {
        type: "text",
        text: expect.stringContaining("All processes running before the restart were killed"),
      },
    ],
  });
  expect(
    planBootNotification(reopened.getEntries(), reopened.buildContextEntries(), {
      runtimeInstanceId: agent.runtimeInstanceId,
      executionId: "new-host",
      incarnation: "0",
    }).kind,
  ).toBe("none");
});

it.each([false, true])(
  "recovers child interruption across notification append/ack loss (committed=%s)",
  async (committed) => {
    const { agent, manager, root } = fixture();
    manager.appendCustomEntry("pi-orb.subagent-run", {
      childId: "lost-leaf",
      operationId: "old-op",
      phase: "admitted",
    });
    let failureSaved = (): void => {};
    const failed = new Promise<void>((resolve) => {
      failureSaved = resolve;
    });
    const append = manager.appendCustomMessageEntry.bind(manager);
    manager.appendCustomMessageEntry = (...args) => {
      const id = append(...args);
      if (args[0] === "pi-orb.restart-notification-failed") failureSaved();
      return id;
    };
    const pi = {
      isIdle: true,
      subscribe: () => () => undefined,
      sendCustomMessage: (message: {
        customType: string;
        content: string;
        display: boolean;
        details: unknown;
      }) => {
        if (committed)
          append(message.customType, message.content, message.display, message.details);
        return Promise.reject(
          new Error(committed ? "injected acknowledgement loss" : "injected append failure"),
        );
      },
    } as unknown as PiSession;
    agent.attachSession(pi, manager, { summarize: () => okAsync("") });
    await failed;
    expect(agent.getHealth()).toMatchObject({
      status: "ready",
      turnResume: { outcome: "resume_failed" },
    });
    const reopened = SessionManager.open(manager.getSessionFile() as string);
    expect(interruptedSubagents(reopened.getEntries())).toEqual(
      committed ? [] : [{ childId: "lost-leaf", operationId: "old-op" }],
    );
    const next = new PiOrbAgent({
      skillsDir: null,
      orbId: "boot-test",
      repositoryUrl: "https://example.com/repo",
      workDir: root,
      broker: null,
      executionId: "third-host",
    });
    let turns = 0;
    next.attachSession(
      {
        ...pi,
        sendCustomMessage: (message, options) => {
          if (options?.triggerTurn) turns++;
          reopened.appendCustomMessageEntry(
            message.customType,
            message.content,
            message.display,
            message.details,
          );
          return Promise.resolve();
        },
      },
      reopened,
      { summarize: () => okAsync("") },
    );
    expect(interruptedSubagents(reopened.getEntries())).toEqual([]);
    // A failed append leaves the ordinary root restart notification unclaimed;
    // a committed notice must not trigger that root turn again after ack loss.
    expect(turns).toBe(committed ? 0 : 1);
    const acknowledgements = reopened
      .getEntries()
      .filter(
        (entry) =>
          entry.type === "custom_message" &&
          (entry.details as { interruptedSubagents?: unknown[] } | undefined)?.interruptedSubagents
            ?.length,
      );
    expect(acknowledgements).toHaveLength(1);
  },
);

it("keeps idle-stop admission fenced across runtime restart, reopening only on a new host execution", async () => {
  const { agent, manager, root } = fixture();
  manager.appendCustomEntry(BOOT_BASELINE_TYPE, {
    runtimeInstanceId: agent.runtimeInstanceId,
    executionId: "new-host",
    incarnation: "0",
  });
  const pi = { isIdle: true, subscribe: () => () => undefined } as unknown as PiSession;
  agent.attachSession(pi, manager, { summarize: () => okAsync("") });
  expect(agent.prepareIdleStop()._unsafeUnwrap()).toBe(true);
  expect(agent.prepareIdleStop()._unsafeUnwrap()).toBe(true);
  expect((await agent.submitMessage([], "late")).isErr()).toBe(true);
  expect((await agent.submitShell("echo forbidden", false, "late-shell")).isErr()).toBe(true);
  expect((await agent.deliverInboxMessage("late-inbox", ["late-inbox"], [])).isErr()).toBe(true);
  expect(agent.admitSubagent("late-child").isErr()).toBe(true);
  const path = manager.getSessionFile() as string;
  expect(
    SessionManager.open(path)
      .getEntries()
      .filter(
        (entry) => entry.type === "custom" && entry.customType === "pi-orb.idle-stop-prepared",
      ),
  ).toHaveLength(1);
  for (const executionId of ["new-host", "next-host"]) {
    const reopened = SessionManager.open(path);
    const next = new PiOrbAgent({
      skillsDir: null,
      orbId: "boot-test",
      repositoryUrl: "https://example.com/repo",
      workDir: root,
      broker: null,
      executionId,
    });
    let notices = 0;
    next.attachSession(
      {
        ...pi,
        sendCustomMessage: (message) => {
          notices++;
          reopened.appendCustomMessageEntry(
            message.customType,
            message.content,
            message.display,
            message.details,
          );
          return Promise.resolve();
        },
      },
      reopened,
      { summarize: () => okAsync("") },
    );
    expect(next.gateView().acceptingWork).toBe(executionId === "next-host");
    expect(notices).toBe(executionId === "next-host" ? 1 : 0);
  }
});

it.each([false, true])(
  "fails idle-stop admission closed on uncertain fence persistence (committed=%s)",
  (committed) => {
    const { agent, manager } = fixture();
    manager.appendCustomEntry(BOOT_BASELINE_TYPE, {
      runtimeInstanceId: agent.runtimeInstanceId,
      executionId: "new-host",
      incarnation: "0",
    });
    agent.attachSession(
      { isIdle: true, subscribe: () => () => undefined } as unknown as PiSession,
      manager,
      { summarize: () => okAsync("") },
    );
    expect(agent.gateView().activity).toBe("idle");
    const append = manager.appendCustomEntry.bind(manager);
    manager.appendCustomEntry = (...args) => {
      if (committed) append(...args);
      throw new Error("injected idle-stop fence persistence failure");
    };
    expect(agent.prepareIdleStop().isErr()).toBe(true);
    expect(agent.gateView().acceptingWork).toBe(false);
    expect(agent.getHealth()).toMatchObject({ status: "failed" });
  },
);

it("reports a typed initialization failure when session context cannot be read", () => {
  const { agent, manager } = fixture();
  manager.buildContextEntries = () => {
    throw new Error("injected session read failure");
  };
  const pi = { subscribe: () => () => undefined } as unknown as PiSession;
  expect(() => agent.attachSession(pi, manager, { summarize: () => okAsync("") })).not.toThrow();
  expect(agent.getHealth()).toMatchObject({
    status: "failed",
    error: { code: "session_init_failed" },
  });
});

it.each(["throw", "reject"])(
  "makes a %s from Pi durable and visible and releases the operation",
  async (mode) => {
    const { agent, manager } = fixture();
    let savedResolve = (): void => {};
    const saved = new Promise<void>((resolve) => {
      savedResolve = resolve;
    });
    const append = manager.appendCustomMessageEntry.bind(manager);
    manager.appendCustomMessageEntry = (...args) => {
      const id = append(...args);
      savedResolve();
      return id;
    };
    const pi = {
      isIdle: true,
      subscribe: () => () => undefined,
      sendCustomMessage: () => {
        if (mode === "throw") throw new Error("injected SDK failure");
        return Promise.reject(new Error("injected SDK failure"));
      },
    } as unknown as PiSession;
    agent.attachSession(pi, manager, { summarize: () => okAsync("") });
    await saved;
    expect(agent.getHealth()).toMatchObject({
      status: "ready",
      activity: "idle",
      turnResume: { outcome: "resume_failed" },
    });
    expect(manager.getEntries().at(-1)).toMatchObject({
      type: "custom_message",
      customType: "pi-orb.restart-notification-failed",
      display: true,
      details: { reason: "delivery_failed", runtimeInstanceId: agent.runtimeInstanceId },
    });
  },
);
