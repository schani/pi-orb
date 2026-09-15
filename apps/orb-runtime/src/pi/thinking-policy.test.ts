import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { restoreSessionSettings } from "./restore-settings.ts";
import { createPersistentSession, syncSessionFile } from "./settings-persistence.ts";

it("real SDK: per-session model/thinking survive reopen before inference without changing global defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orb-thinking-"));
  try {
    const models = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      allowModelNetwork: false,
    });
    await models.setRuntimeApiKey("openai", "test-not-a-secret");
    const candidates = models
      .getModels("openai")
      .filter((model) => model.reasoning && model.input.includes("image"));
    const first = candidates[0],
      second = candidates[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;
    const created = createPersistentSession(dir, join(dir, "sessions"));
    expect(created.isOk()).toBe(true);
    if (created.isErr()) return;
    const defaults = SettingsManager.inMemory({ defaultThinkingLevel: "high" });
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      sessionManager: created.value,
      modelRuntime: models,
      settingsManager: defaults,
      model: first,
      thinkingLevel: "high",
    });
    const observed: string[] = [];
    session.subscribe((event) => observed.push(event.type));
    await session.setModel(second);
    session.setThinkingLevel("low");
    const actual = session.thinkingLevel;
    const file = created.value.getSessionFile();
    expect(file).toBeDefined();
    if (!file) return;
    expect(syncSessionFile(file).isOk()).toBe(true);
    expect(defaults.getDefaultThinkingLevel()).toBe("high");
    expect(observed).toContain("thinking_level_changed");
    session.dispose();
    const reopened = SessionManager.open(file, join(dir, "sessions"), dir);
    expect(reopened.buildSessionContext().model).toEqual({
      provider: second.provider,
      modelId: second.id,
    });
    const selection = restoreSessionSettings(reopened, candidates);
    expect(selection?.model.id).toBe(second.id);
    const beforeBinding = reopened.getEntries();
    const restored = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      sessionManager: reopened,
      modelRuntime: models,
      settingsManager: defaults,
      ...selection,
    });
    expect(restored.session.model?.id).toBe(second.id);
    expect(restored.session.thinkingLevel).toBe(actual);
    // SDK initialization treats message-free sessions as fresh, even with saved settings.
    // It appends binding metadata again; preserve its history rather than rewriting IDs.
    expect(reopened.getEntries().slice(beforeBinding.length)).toMatchObject([
      { type: "model_change", provider: second.provider, modelId: second.id },
      { type: "thinking_level_change", thinkingLevel: actual },
    ]);
    expect(reopened.getEntries().some((entry) => entry.type === "message")).toBe(false);
    // Public event subscribers can reject a setter after native mutation and append.
    // A non-reasoning model also proves that capability clamping changes the effective level.
    const unsubscribe = restored.session.subscribe((event) => {
      if (event.type === "thinking_level_changed")
        throw new Error("subscriber failed after append");
    });
    await expect(restored.session.setModel({ ...first, reasoning: false })).rejects.toThrow(
      "subscriber failed after append",
    );
    expect(restored.session.model?.id).toBe(first.id);
    expect(restored.session.thinkingLevel).toBe("off");
    expect(syncSessionFile(file).isOk()).toBe(true);
    const afterFailure = SessionManager.open(
      file,
      join(dir, "sessions"),
      dir,
    ).buildSessionContext();
    expect(afterFailure.model).toEqual({ provider: first.provider, modelId: first.id });
    expect(afterFailure.thinkingLevel).toBe("off");
    expect(defaults.getDefaultThinkingLevel()).toBe("high");
    unsubscribe();
    restored.session.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
