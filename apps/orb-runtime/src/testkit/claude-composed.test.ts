import fs, { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { nativeHistoryFiles } from "../claude/history.ts";
import { ComposedClaudeFixture } from "./claude-composed.ts";

it("commits agent and history journals to real files without fsync", async () => {
  const fsync = vi.spyOn(fs, "fsyncSync");
  syncBuiltinESMExports();
  const f = new ComposedClaudeFixture();
  try {
    nativeHistoryFiles.commit(join(f.dir, "control.json"), "{}");
    expect(fsync).toHaveBeenCalled();
    fsync.mockClear();

    expect((await f.attach()).isOk()).toBe(true);
    expect(
      (await f.agent.submitMessage([{ type: "text", text: "hello" }], "operation")).isOk(),
    ).toBe(true);
    f.append({ type: "user", uuid: "native", message: { content: "hello" } });
    expect(f.history.scan(f.nativePath).isOk()).toBe(true);

    expect(f.journal().id).toBe(f.state.id);
    expect(existsSync(join(f.dir, "claude", "provenance.json"))).toBe(true);
    expect(fsync).not.toHaveBeenCalled();
  } finally {
    f.dispose();
    fsync.mockRestore();
    syncBuiltinESMExports();
  }
});
