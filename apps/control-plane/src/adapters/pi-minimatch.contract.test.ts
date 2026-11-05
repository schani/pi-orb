import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  DefaultPackageManager,
  type ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

it("Pi package filters retain braces, globstars, negation and exact override precedence", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-minimatch-"));
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "extensions", "nested"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      pi: { extensions: ["extensions/*.ts", "extensions/*.js", "extensions/nested/*.js"] },
    }),
  );
  for (const file of [
    "keep.ts",
    "disabled.ts",
    "remove.js",
    "nested/keep.js",
    "nested/disabled.js",
  ]) {
    writeFileSync(join(packageRoot, "extensions", file), "export {};");
  }
  const manager = new DefaultPackageManager({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager: SettingsManager.inMemory({
      packages: [
        {
          source: packageRoot,
          extensions: [
            "**/*.{ts,js}",
            "!**/disabled.*",
            "+extensions/disabled.ts",
            "-extensions/remove.js",
          ],
        },
      ],
    }),
  });
  try {
    const resources = (await manager.resolve()).extensions;
    const enabled = Object.fromEntries(
      resources.map((resource) => [
        relative(packageRoot, resource.path).replaceAll("\\", "/"),
        resource.enabled,
      ]),
    );
    expect(enabled).toEqual({
      "extensions/keep.ts": true,
      "extensions/disabled.ts": true,
      "extensions/remove.js": false,
      "extensions/nested/keep.js": true,
      "extensions/nested/disabled.js": false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("Pi model selection retains nocase provider globs and brace alternatives", async () => {
  const models: Model<"anthropic-messages">[] = [
    "claude-sonnet-fixture",
    "claude-haiku-fixture",
    "claude-opus-fixture",
  ].map((id) => ({
    id,
    name: id,
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://fixture.invalid",
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  }));
  const modelRuntime = { getAvailable: async () => models } as unknown as ModelRuntime;
  const result = await resolveModelScopeWithDiagnostics(
    ["ANTHROPIC/CLAUDE-{SONNET,HAIKU}*"],
    modelRuntime,
  );
  const expected = models.filter((model) => /^claude-(sonnet|haiku)/i.test(model.id));
  expect(expected.length).toBeGreaterThan(0);
  expect(result.scopedModels.map((scoped) => scoped.model)).toEqual(expected);
  expect(result.diagnostics).toEqual([]);
});
