import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { findNativeClaudeTranscript } from "./native-path.ts";

it("finds the native root by retained UUID without recreating long-path hash rules", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-native-path-"));
  try {
    expect(findNativeClaudeTranscript(dir, "session")._unsafeUnwrap()).toBeNull();
    const root = join(dir, "projects", "truncated-workspace-djb2-hash");
    mkdirSync(join(root, "session", "subagents"), { recursive: true });
    writeFileSync(join(root, "session", "subagents", "agent-child.jsonl"), "private\n");
    writeFileSync(join(root, "session.jsonl"), "root\n");
    expect(findNativeClaudeTranscript(dir, "session")._unsafeUnwrap()).toBe(
      join(root, "session.jsonl"),
    );
    mkdirSync(join(dir, "projects", "duplicate"));
    writeFileSync(join(dir, "projects", "duplicate", "session.jsonl"), "duplicate\n");
    expect(findNativeClaudeTranscript(dir, "session").isErr()).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
