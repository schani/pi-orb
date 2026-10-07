import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { createPersistentSession, syncSessionFile } from "./settings-persistence.ts";

it("native manual compaction honors instructions, appends canonical history and restores after reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orb-manual-compact-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const manager = createPersistentSession(dir, join(dir, "sessions"))._unsafeUnwrap();
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      allowModelNetwork: false,
    });
    const faux = fauxProvider({ provider: "compact-contract" });
    const summaryRequests: string[] = [];
    faux.setResponses([
      fauxAssistantMessage("done"),
      fauxAssistantMessage("done again"),
      (context) => {
        summaryRequests.push(JSON.stringify(context));
        return fauxAssistantMessage("COMPACTED_DECISIONS");
      },
      (context) => {
        summaryRequests.push(JSON.stringify(context));
        return fauxAssistantMessage("COMPACTED_PREFIX");
      },
    ]);
    runtime.registerNativeProvider(faux.provider);
    let cancelNext = false;
    let started: (() => void) | undefined;
    const cancellationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dir, "agent"),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        (pi) => {
          pi.on("session_before_compact", async (event) => {
            if (!cancelNext) return;
            started?.();
            await new Promise<void>((resolve) => {
              if (event.signal.aborted) resolve();
              else event.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            return { cancel: true };
          });
        },
      ],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: dir,
      agentDir: join(dir, "agent"),
      sessionManager: manager,
      modelRuntime: runtime,
      model: faux.getModel(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false, keepRecentTokens: 1 },
      }),
      resourceLoader: loader,
      noTools: "all",
    }));
    await session.prompt("retain this decision");
    await session.prompt("continue this work");
    const events: string[] = [];
    session.subscribe((event) => events.push(event.type));
    const result = await session.compact("CUSTOM_COMPACT_INSTRUCTION");
    await session.waitForIdle();
    expect(result.summary).toContain("COMPACTED_DECISIONS");
    expect(summaryRequests).toHaveLength(2);
    expect(summaryRequests.some((request) => request.includes("CUSTOM_COMPACT_INSTRUCTION"))).toBe(
      true,
    );
    expect(events).toEqual(["compaction_start", "compaction_end"]);
    expect(session.isIdle).toBe(true);
    const file = manager.getSessionFile();
    expect(file).toBeDefined();
    if (!file) return;
    expect(syncSessionFile(file).isOk()).toBe(true);
    const reopened = SessionManager.open(file, join(dir, "sessions"), dir);
    expect(reopened.getEntries()).toEqual(manager.getEntries());
    expect(
      reopened
        .buildSessionContext()
        .messages.some((message) => JSON.stringify(message).includes("COMPACTED_DECISIONS")),
    ).toBe(true);
    expect(reopened.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
    const assistant = manager
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (assistant?.type !== "message" || assistant.message.role !== "assistant") return;
    manager.appendMessage({ role: "user", content: "later input", timestamp: 3 });
    manager.appendMessage(assistant.message);
    cancelNext = true;
    const cancelled = session.compact();
    const rejection = expect(cancelled).rejects.toThrow("Compaction cancelled");
    await cancellationStarted;
    expect(session.isIdle).toBe(false);
    session.abortCompaction();
    await rejection;
    await session.waitForIdle();
    expect(session.isIdle).toBe(true);
    expect(manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
  } finally {
    session?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
