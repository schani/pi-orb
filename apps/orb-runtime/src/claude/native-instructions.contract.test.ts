import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { probeNativeSdk } from "../../../../scripts/claude-sdk-contract/probe.mjs";

const nativeIt = it.skipIf(process.platform !== "linux" || process.arch !== "x64");

nativeIt.each(["agents-only", "claude-preferred", "symlink", "import"] as const)(
  "native project instructions: %s",
  async (layout) => {
    const agentsMarker = "native-agents-unique-instruction-marker";
    const claudeMarker = "native-claude-unique-instruction-marker";
    const requests: string[] = [];
    const result = await probeNativeSdk({
      beforeQuery(options) {
        options.settingSources = ["user", "project", "local"];
        options.systemPrompt = { type: "preset", preset: "claude_code" };
        const cwd = options.cwd;
        if (!cwd) throw new Error("Native probe did not provide cwd.");
        writeFileSync(join(cwd, "AGENTS.md"), agentsMarker);
        if (layout === "claude-preferred") writeFileSync(join(cwd, "CLAUDE.md"), claudeMarker);
        if (layout === "symlink") symlinkSync("AGENTS.md", join(cwd, "CLAUDE.md"));
        if (layout === "import") writeFileSync(join(cwd, "CLAUDE.md"), "@AGENTS.md");
      },
      onRequest(body) {
        requests.push(JSON.stringify(body));
      },
    });
    expect(result.sdkVersion).toBe("0.3.310");
    expect(result.cliVersion).toBe("2.1.310");
    expect(result.result.isError).toBe(false);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]?.split(agentsMarker).length).toBe(layout === "claude-preferred" ? 1 : 2);
    expect(requests[0]?.split(claudeMarker).length).toBe(layout === "claude-preferred" ? 2 : 1);
  },
);
