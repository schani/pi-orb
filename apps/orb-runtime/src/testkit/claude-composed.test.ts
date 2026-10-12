import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { nativeHistoryFiles } from "../claude/history.ts";
import { ComposedClaudeFixture } from "./claude-composed.ts";

it("keeps agent and history journals in memory, off disk and without fsync", async () => {
  const f = new ComposedClaudeFixture();
  const writes = [vi.spyOn(fs, "renameSync"), vi.spyOn(fs, "fsyncSync")];
  syncBuiltinESMExports();
  try {
    nativeHistoryFiles.commit(join(f.dir, "control.json"), "{}");
    for (const write of writes) expect(write).toHaveBeenCalled();
    for (const write of writes) write.mockClear();

    expect((await f.attach()).isOk()).toBe(true);
    expect(
      (await f.agent.submitMessage([{ type: "text", text: "hello" }], "operation")).isOk(),
    ).toBe(true);
    f.append({ type: "user", uuid: "native", message: { content: "hello" } });
    expect(f.history.scan(f.nativePath).isOk()).toBe(true);
    expect(f.history.view.map((record) => record.id)).toContain("native");

    expect(f.journal().id).toBe(f.state.id);
    expect(f.files.read(join(f.dir, "claude", "provenance.json"))).not.toBeNull();
    expect(fs.readdirSync(join(f.dir, "claude"))).toEqual([]);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  } finally {
    for (const write of writes) write.mockRestore();
    syncBuiltinESMExports();
    f.dispose();
  }
});
