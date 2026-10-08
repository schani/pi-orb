import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { ClaudeOrbAgent } from "./agent.ts";

const trigger = vi.hoisted(() => vi.fn(() => okAsync(undefined)));
vi.mock("../naming/client.ts", () => ({ triggerOrbName: trigger }));

it("triggers bounded Luna naming once without waiting for it", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "claude-naming-"));
  try {
    mkdirSync(join(workDir, "repo"));
    writeFileSync(join(workDir, "repo", "README.md"), "# Repository");
    const broker = { controlPlaneUrl: "https://control.example", runtimeToken: "token" };
    const agent = new ClaudeOrbAgent({
      orbId: "orb",
      repositoryUrl: "https://example.com/repo",
      workDir,
      skillsDir: null,
      broker,
    });
    agent.triggerAutoName([{ type: "text", text: "Fix reconnects" }]);
    agent.triggerAutoName([{ type: "text", text: "Not the first message" }]);
    await vi.waitFor(() => expect(trigger).toHaveBeenCalledOnce());
    expect(trigger).toHaveBeenCalledWith(broker, {
      text: "Fix reconnects",
      imageOnly: false,
      readme: "# Repository",
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
