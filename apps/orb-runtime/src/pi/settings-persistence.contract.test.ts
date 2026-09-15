import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { createPersistentSession, syncSessionFile } from "./settings-persistence.ts";

it("returns typed errors for path creation and disk-sync failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "orb-settings-errors-"));
  try {
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "keep");
    expect(createPersistentSession(dir, blocked).isErr()).toBe(true);
    expect(syncSessionFile(join(dir, "missing.jsonl")).isErr()).toBe(true);
    expect(readFileSync(blocked, "utf8")).toBe("keep");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("persists settings before any assistant, with SDK-owned header and stable cursor IDs", () => {
  const dir = mkdtempSync(join(tmpdir(), "orb-settings-"));
  try {
    const result = createPersistentSession(dir, join(dir, "sessions"));
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    const session = result.value;
    session.appendModelChange("openai-codex", "gpt-6-astra");
    session.appendThinkingLevelChange("low");
    const file = session.getSessionFile();
    expect(file).toBeDefined();
    if (!file) return;
    const reopened = SessionManager.open(file, join(dir, "sessions"), dir);
    expect(reopened.getEntries()).toEqual(session.getEntries());
    expect(reopened.getSessionId()).toBe(session.getSessionId());
    expect(reopened.buildSessionContext().thinkingLevel).toBe("low");
    reopened.appendThinkingLevelChange("high");
    expect(SessionManager.open(file).getEntries()).toEqual(reopened.getEntries());
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines.filter((line) => JSON.parse(line).type === "session")).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
