import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { validateClaudeAuthSettings } from "./auth-settings.ts";

it("rejects native project auth overrides without exposing their values", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-auth-settings-"));
  try {
    mkdirSync(join(dir, ".claude"));
    const path = join(dir, ".claude", "settings.json");
    for (const settings of [
      { env: { ANTHROPIC_API_KEY: "secret" } },
      { env: { CLAUDE_CODE_OAUTH_TOKEN: "other-owner-secret" } },
      { env: { CLAUDE_CONFIG_DIR: "/profile" } },
      { apiKeyHelper: "cat secret" },
    ]) {
      writeFileSync(path, JSON.stringify(settings));
      const result = validateClaudeAuthSettings(dir, join(dir, "config"));
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).not.toContain("secret");
    }
    writeFileSync(path, JSON.stringify({ env: { PROJECT_TEST: "value" }, hooks: {} }));
    expect(validateClaudeAuthSettings(dir, join(dir, "config")).isOk()).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
