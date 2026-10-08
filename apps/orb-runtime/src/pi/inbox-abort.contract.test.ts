import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { okAsync } from "neverthrow";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { PiOrbAgent } from "./agent.ts";

it("real SDK: retrying an unpersisted inbox steer after abort must make progress without duplication", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orb-inbox-abort-"));
  let entered!: () => void;
  const inferenceEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let recoveredContextCount = 0;
  let interruptedToolExecutions = 0;
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      allowModelNetwork: false,
    });
    const faux = fauxProvider({ provider: "inbox-abort-contract" });
    runtime.registerNativeProvider(faux.provider);
    faux.setResponses([
      async (_context, options) => {
        entered();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return fauxAssistantMessage(fauxToolCall("abort_probe", {}));
      },
      (context) => {
        recoveredContextCount =
          JSON.stringify(context.messages).split("What’s happening???").length - 1;
        return fauxAssistantMessage("recovered");
      },
    ]);
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dir, "agent"),
      extensionFactories: [],
    });
    await resourceLoader.reload();
    const manager = SessionManager.create(dir, join(dir, "sessions"));
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: join(dir, "agent"),
      sessionManager: manager,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory(),
      resourceLoader,
      model: faux.getModel(),
      customTools: [
        {
          name: "abort_probe",
          label: "Abort probe",
          description: "Must never replay.",
          parameters: Type.Object({}),
          execute: async () => {
            interruptedToolExecutions++;
            return { content: [], details: undefined };
          },
        },
      ],
    });
    const summarizer = { summarize: () => okAsync("") };
    const agent = new PiOrbAgent({
      skillsDir: null,
      orbId: "orb-inbox-abort",
      repositoryUrl: "https://example.com/repo.git",
      workDir: dir,
      broker: null,
      turnSummarizer: summarizer,
    });
    agent.attachSession(session, manager, summarizer);
    const operationId = "b8f65516-41c4-4654-aede-db0a6066e0e1";
    const batchId = "c6a07a79";
    const content = [{ type: "text" as const, text: "What’s happening???" }];
    const persisted = () =>
      manager
        .getEntries()
        .filter(
          (entry) =>
            entry.type === "custom_message" &&
            (entry.details as { messageIds?: string[] } | undefined)?.messageIds?.includes(batchId),
        );
    try {
      const original = agent.submitMessage([{ type: "text", text: "start" }], operationId);
      await inferenceEntered;
      const accepted = await agent.deliverInboxMessage(batchId, [batchId], content);
      expect(accepted.isOk()).toBe(true);
      if (accepted.isErr()) return;
      expect(accepted.value).toMatchObject({
        status: "queued",
        delivery: "steer",
        operationId,
        duplicate: false,
      });
      expect(persisted()).toHaveLength(0);
      expect(session.agent.hasQueuedMessages()).toBe(true);
      expect(
        session.cancelQueuedCustomSteer("pi-orb.user-message", {
          operationId,
          messageIds: [batchId],
        }),
      ).toBe(false);

      expect((await agent.abortOperation()).isOk()).toBe(true);
      await original;
      await session.waitForIdle();
      expect(session.isIdle).toBe(true);
      expect(agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
      expect(persisted()).toHaveLength(0);
      // Abort retains the native queue: dropping only the adapter dedup is unsafe.
      expect(session.agent.hasQueuedMessages()).toBe(true);

      for (const identity of [
        { operationId: "wrong-operation", messageIds: [batchId] },
        { operationId, messageIds: [batchId, "not-in-the-frozen-batch"] },
      ]) {
        expect(session.cancelQueuedCustomSteer("pi-orb.user-message", identity)).toBe(false);
      }
      expect(
        session.cancelQueuedCustomSteer("extension-message", {
          operationId,
          messageIds: [batchId],
        }),
      ).toBe(false);
      expect(session.agent.hasQueuedMessages()).toBe(true);

      // Concurrent/lost-response retries join one new operation, then deduplicate
      // against the canonical receipt, never against the abandoned operation.
      const retries = await Promise.all(
        Array.from({ length: 3 }, () => agent.deliverInboxMessage(batchId, [batchId], content)),
      );
      const newOperationIds = new Set<string>();
      for (const retry of retries) {
        expect(retry.isOk()).toBe(true);
        if (retry.isErr()) return;
        expect(retry.value.operationId).not.toBe(operationId);
        expect(retry.value.delivery).toBe("turn");
        newOperationIds.add(retry.value.operationId);
      }
      expect(newOperationIds.size).toBe(1);
      await session.waitForIdle();
      const duplicate = await agent.deliverInboxMessage(batchId, [batchId], content);
      expect(duplicate.isOk() && duplicate.value).toMatchObject({
        status: "persisted",
        duplicate: true,
      });
      expect(faux.state.callCount).toBe(2);
      expect(recoveredContextCount).toBe(1);
      expect(interruptedToolExecutions).toBe(0);
      expect(session.isIdle).toBe(true);
      const recovery = manager
        .getEntries()
        .filter(
          (entry) =>
            entry.type === "custom_message" && entry.customType === "pi-orb.inbox-recovery",
        );
      expect(recovery).toHaveLength(1);
      expect(JSON.stringify(recovery)).not.toContain("What’s happening???");
      // Regression invariant: an idle retry must drain the existing steer, not
      // acknowledge it indefinitely without persisting a single inbox record.
      expect(persisted()).toHaveLength(1);
      const receipt = persisted()[0];
      expect(receipt?.type === "custom_message" && receipt.details).toMatchObject({
        messageIds: [batchId],
        operationId: [...newOperationIds][0],
        delivery: "turn",
      });
      const file = manager.getSessionFile();
      expect(file).toBeDefined();
      if (file) {
        const reopened = SessionManager.open(file);
        expect(reopened.getEntry(receipt?.id ?? "missing")).toEqual(receipt);
        expect(
          reopened
            .getEntries()
            .filter(
              (entry) =>
                entry.type === "custom_message" && entry.customType === "pi-orb.inbox-recovery",
            ),
        ).toEqual(recovery);
      }
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
