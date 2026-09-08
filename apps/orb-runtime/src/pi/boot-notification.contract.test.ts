import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { okAsync } from "neverthrow";
import { afterEach, expect, it } from "vitest";
import { PiOrbAgent, type PiSession } from "./agent.ts";
import { BOOT_BASELINE_TYPE, planBootNotification } from "./boot-notification.ts";

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
