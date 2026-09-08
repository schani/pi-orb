import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const commit = `6${"a".repeat(39)}`;
const shortCommit = commit.slice(0, 7);
const accepted = {
  schemaVersion: 1,
  status: "accepted",
  validation: true,
  sourceDirty: false,
  project: "test-project",
  sourceCommit: commit,
  imageResource: "projects/test-project/global/images/pi-orb-test",
  imageId: "1234567890123456789",
  workspaceImageResource: "projects/test-project/global/images/pi-orb-workspace-test",
  workspaceImageId: "2234567890123456789",
};

function consume(manifest: unknown) {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-manifest-"));
  try {
    const path = join(root, "manifest.json");
    writeFileSync(path, typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    return spawnSync(
      process.execPath,
      [resolve("infra/native-image-vars.mjs"), path, commit, "test-project"],
      { encoding: "utf8" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("native image release manifest", () => {
  it("carries an accepted identity without losing numeric precision", () => {
    const result = consume(accepted);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      'native_image_resource = "projects/test-project/global/images/pi-orb-test"\nnative_image_id = "1234567890123456789"\nworkspace_image_resource = "projects/test-project/global/images/pi-orb-workspace-test"\nworkspace_image_id = "2234567890123456789"\n',
    );
  });

  it.each([
    { status: "failed" },
    { validation: false },
    { sourceDirty: true },
    { sourceDirty: undefined },
    { schemaVersion: 2 },
    { sourceCommit: "b".repeat(40) },
    { project: "other-project" },
    { imageResource: "projects/test-project/global/images/family/pi-orb" },
    { imageResource: "projects/other-project/global/images/pi-orb-test" },
    { imageResource: 'projects/test-project/global/images/pi-orb-test"\nmalicious = true' },
    { imageId: 12345 },
    { imageId: "1e20" },
    { imageId: "" },
    { workspaceImageResource: "projects/test-project/global/images/family/pi-orb-workspace" },
    { workspaceImageResource: "projects/other-project/global/images/pi-orb-workspace" },
    { workspaceImageId: 22345 },
    { workspaceImageId: "2e20" },
    { workspaceImageId: "" },
  ])("refuses unaccepted or mismatched input %j", (override) => {
    const result = consume({ ...accepted, ...override });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("refuses malformed JSON without printing its contents", () => {
    const result = consume("invalid sensitive input");
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("sensitive");
    expect(result.stdout).toBe("");
  });
});

// The shell stage is exercised with process adapters, including its publication order.
describe("native build release stage", () => {
  it.each(["accepted", "failed", "wrong-commit"])(
    "publishes only after an accepted build: %s",
    (outcome) => {
      const root = mkdtempSync(join(tmpdir(), "pi-orb-build-release-"));
      try {
        const bin = join(root, "bin");
        mkdirSync(bin);
        mkdirSync(join(root, "infra"));
        const log = join(root, "calls");
        copyFileSync(resolve("infra/build-push.sh"), join(root, "infra/build-push.sh"));
        copyFileSync(resolve("infra/release-child.sh"), join(root, "infra/release-child.sh"));
        copyFileSync(
          resolve("infra/native-image-vars.mjs"),
          join(root, "infra/native-image-vars.mjs"),
        );
        const script = (name: string, source: string) => {
          const path = join(bin, name);
          writeFileSync(path, `#!/bin/bash\nset -eu\n${source}\n`);
          chmodSync(path, 0o755);
        };
        script(
          "git",
          `if [ "$*" = "rev-parse HEAD" ]; then echo ${commit}; else echo ${shortCommit}; fi`,
        );
        script(
          "node",
          `if [ "\${2:-}" != packages/native-image/src/cli.ts ]; then exec "$REAL_NODE" "$@"; fi
version=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = --version ]; then version="$2"; break; fi
  shift
done
[[ "$version" =~ ^[a-z]([-a-z0-9]*[a-z0-9])?$ ]] || exit 64
echo "native-build:$version" >> "$CALL_LOG"
mkdir -p "$IMAGE_BUILD_DIR"
cat > "$IMAGE_BUILD_DIR/manifest.json" <<'JSON'
${JSON.stringify({ ...accepted, status: outcome === "failed" ? "failed" : "accepted", sourceCommit: outcome === "wrong-commit" ? "b".repeat(40) : commit })}
JSON`,
        );
        script(
          "docker",
          `echo "docker:$1" >> "$CALL_LOG"
if [ "$1" = inspect ]; then echo 'registry/control@sha256:${"a".repeat(64)}'; fi`,
        );
        const result = spawnSync("bash", [join(root, "infra/build-push.sh")], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            PROJECT: "test-project",
            IMAGE_BUILD_DIR: join(root, "image"),
            CALL_LOG: log,
            REAL_NODE: process.execPath,
          },
        });
        const calls = readFileSync(log, "utf8");
        if (outcome === "accepted") {
          expect(result.status, result.stderr).toBe(0);
          expect(calls.trim().split("\n")).toEqual([
            `native-build:v-${shortCommit}`,
            "docker:build",
            "docker:push",
            "docker:inspect",
          ]);
          expect(result.stdout).toContain('native_image_id = "1234567890123456789"');
        } else {
          expect(result.status).toBe(1);
          expect(calls.trim()).toBe(`native-build:v-${shortCommit}`);
          expect(result.stdout).toBe("");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
