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
import { activateCodemode } from "./extensions/index.ts";
import { createOrbResourceLoader } from "./resource-loader.ts";

it("enables codemode without MCP while retaining selected tools", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-codemode-active-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const agentDir = join(cwd, "agent");
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["read"] });
    const loader = (
      await createOrbResourceLoader({ cwd, agentDir, skillsDir: null, settingsManager })
    )._unsafeUnwrap();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(cwd, "auth.json"),
      allowModelNetwork: false,
    });
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      resourceLoader: loader,
      modelRuntime,
      sessionManager: SessionManager.inMemory(),
    }));
    await session.bindExtensions({});
    expect(session.getActiveToolNames()).toContain("read");
    expect(session.getActiveToolNames()).not.toContain("codemode");
    expect(activateCodemode(session).isOk()).toBe(true);
    expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "codemode"]));
  } finally {
    session?.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});
