import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { validateClaudeAuthSettings } from "./auth-settings.ts";

it("rejects native project auth overrides without exposing their values", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-auth-settings-"));
  try {
    mkdirSync(join(dir, ".claude"));
    const path = join(dir, ".claude", "settings.json");
    for (const settings of [
      { env: { CLAUDE_CODE_OAUTH_TOKEN: "other-owner-secret" } },
      { env: { CLAUDE_CONFIG_DIR: "/profile" } },
      { env: { CLAUDE_CODE_USE_VERTEX: "1" } },
    ]) {
      writeFileSync(path, JSON.stringify(settings));
      const result = validateClaudeAuthSettings(dir, join(dir, "config"));
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).not.toContain("secret");
    }
    writeFileSync(
      path,
      JSON.stringify({
        env: { PROJECT_TEST: "value", AWS_PROFILE: "dev", GOOGLE_APPLICATION_CREDENTIALS: "/a" },
        hooks: {},
      }),
    );
    expect(validateClaudeAuthSettings(dir, join(dir, "config")).isOk()).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(["project", "local", "config"])(
  "validates isolated %s settings without private diagnostics",
  (source) => {
    const dir = mkdtempSync(join(tmpdir(), "claude-auth-source-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const config = join(dir, "config");
    mkdirSync(join(dir, ".claude"));
    mkdirSync(config);
    const path =
      source === "config"
        ? join(config, "settings.json")
        : join(dir, ".claude", source === "local" ? "settings.local.json" : "settings.json");
    expect(validateClaudeAuthSettings(dir, config).isOk()).toBe(true);
    for (const value of [
      { env: { ANTHROPIC_API_KEY: "PRIVATE_VALUE" } },
      { apiKeyHelper: "PRIVATE_VALUE" },
      null,
      [],
      "PRIVATE_VALUE",
      42,
    ]) {
      writeFileSync(path, JSON.stringify(value));
      const error = validateClaudeAuthSettings(dir, config)._unsafeUnwrapErr();
      expect(error).toMatchObject({ code: "claude_auth_required", retryable: false });
      expect(error.message).not.toContain("PRIVATE_VALUE");
      rmSync(path);
      expect(validateClaudeAuthSettings(dir, config).isOk()).toBe(true);
    }
    writeFileSync(path, "{PRIVATE_VALUE");
    expect(validateClaudeAuthSettings(dir, config)._unsafeUnwrapErr()).toEqual({
      code: "claude_auth_required",
      retryable: false,
      message: "Cannot validate native Claude authentication settings.",
    });
    rmSync(path);
    mkdirSync(path);
    expect(validateClaudeAuthSettings(dir, config)._unsafeUnwrapErr()).toEqual({
      code: "claude_auth_required",
      retryable: false,
      message: "Cannot validate native Claude authentication settings.",
    });
  },
);
