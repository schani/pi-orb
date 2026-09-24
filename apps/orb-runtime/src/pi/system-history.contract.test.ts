import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { mapPiEntry } from "./mapping.ts";
import { createOrbResourceLoader } from "./resource-loader.ts";

const PERSONAL_SENTINEL = "REAL_SDK_PERSONAL_SYSTEM_SENTINEL";
const PROJECT_SENTINEL = "REAL_SDK_PROJECT_SYSTEM_SENTINEL";
const TOOL_SENTINEL = "REAL_SDK_TOOL_SYSTEM_SENTINEL";

it("real SDK: persists full system state locally but maps only its identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orb-system-history-"));
  try {
    const sessionDir = join(dir, "sessions");
    const manager = SessionManager.create(dir, sessionDir);
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      allowModelNetwork: false,
    });
    const faux = fauxProvider({ provider: "system-history-contract" });
    faux.setResponses([fauxAssistantMessage("contract complete")]);
    runtime.registerNativeProvider(faux.provider);
    const loader = await createOrbResourceLoader({
      cwd: dir,
      agentDir: join(dir, "agent"),
      skillsDir: null,
      personalInstructions: { content: PERSONAL_SENTINEL, revision: 1 },
      projectInstructions: { content: PROJECT_SENTINEL, revision: 1 },
    });
    expect(loader.isOk()).toBe(true);
    if (loader.isErr()) return;

    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: join(dir, "agent"),
      sessionManager: manager,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory(),
      resourceLoader: loader.value,
      model: faux.getModel(),
      customTools: [
        {
          name: "system_history_sentinel",
          label: "System history sentinel",
          description: TOOL_SENTINEL,
          parameters: Type.Object({ value: Type.String() }),
          execute: async () => ({
            content: [{ type: "text", text: "unused" }],
            details: undefined,
          }),
        },
      ],
    });

    await session.prompt("persist the system state");
    session.dispose();

    const entries = manager.getEntries();
    const system = entries.find(
      (entry) => entry.type === "message" && entry.message.role === "system",
    );
    expect(system).toBeDefined();
    const local = JSON.stringify(system);
    expect(local).toContain(PERSONAL_SENTINEL);
    expect(local).toContain(PROJECT_SENTINEL);
    expect(local).toContain(TOOL_SENTINEL);

    const file = manager.getSessionFile();
    expect(file).toBeDefined();
    if (file === undefined || system === undefined) return;
    const jsonl = readFileSync(file, "utf8");
    expect(jsonl).toContain(PERSONAL_SENTINEL);
    expect(jsonl).toContain(PROJECT_SENTINEL);
    expect(jsonl).toContain(TOOL_SENTINEL);

    const mapped = entries.map((entry) => mapPiEntry(entry)._unsafeUnwrap());
    expect(mapped.map((record) => record.id)).toEqual(entries.map((entry) => entry.id));
    expect(mapped.map((record) => record.parentId)).toEqual(entries.map((entry) => entry.parentId));
    const replicated = JSON.stringify(mapped);
    expect(replicated).not.toContain(PERSONAL_SENTINEL);
    expect(replicated).not.toContain(PROJECT_SENTINEL);
    expect(replicated).not.toContain(TOOL_SENTINEL);
    expect(mapped.find((record) => record.id === system.id)).toMatchObject({
      type: "event",
      eventType: "pi.message.system",
      id: system.id,
      parentId: system.parentId,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
