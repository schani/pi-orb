import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const sdk = JSON.parse(
  readFileSync(
    join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"),
    "utf8",
  ),
);
assert.equal(sdk.version, "0.3.289");
const musl = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime;
const platform = `${process.platform}-${process.arch}${musl ? "-musl" : ""}`;
const executable = require.resolve(
  `@anthropic-ai/claude-agent-sdk-${platform}/${process.platform === "win32" ? "claude.exe" : "claude"}`,
);
const version = execFileSync(executable, ["--version"], {
  encoding: "utf8",
  env: { PATH: process.env.PATH },
  timeout: 10_000,
}).trim();
assert.equal(version, "2.1.289 (Claude Code)");
console.log(`CLAUDE_SDK_OK ${sdk.version} / 2.1.289`);
