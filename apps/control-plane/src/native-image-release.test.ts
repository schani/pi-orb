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
  schemaVersion: 2,
  status: "accepted",
  validation: true,
  validationHostKeyFingerprint: "SHA256:validatorKey=",
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
    { validationHostKeyFingerprint: undefined },
    { validationHostKeyFingerprint: "validatorKey" },
    { sourceDirty: true },
    { sourceDirty: undefined },
    { schemaVersion: 1 },
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
  it.each(["accepted", "failed", "wrong-commit", "container-failed"])(
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
for _ in {1..200}; do
  grep -q '^docker:build$' "$CALL_LOG" && break
  sleep 0.01
done
grep -q '^docker:build$' "$CALL_LOG"
if [ "${outcome}" = container-failed ]; then
  trap 'echo native-clean >> "$CALL_LOG"; exit 143' TERM
  echo native-block-ready >> "$CALL_LOG"
  while :; do sleep 1; done
fi
mkdir -p "$IMAGE_BUILD_DIR"
cat > "$IMAGE_BUILD_DIR/manifest.json" <<'JSON'
${JSON.stringify({ ...accepted, status: outcome === "failed" ? "failed" : "accepted", sourceCommit: outcome === "wrong-commit" ? "b".repeat(40) : commit })}
JSON`,
        );
        script(
          "docker",
          `echo "docker:$1" >> "$CALL_LOG"
if [ "$1" = build ] && [ "${outcome}" = container-failed ]; then
  while ! grep -q '^native-block-ready$' "$CALL_LOG"; do sleep 0.01; done
  exit 9
fi
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
        const calls = readFileSync(log, "utf8").trim().split("\n");
        expect(calls).toContain(`native-build:v-${shortCommit}`);
        expect(calls).toContain("docker:build");
        if (outcome === "accepted") {
          expect(result.status, result.stderr).toBe(0);
          expect(calls.indexOf("docker:push")).toBeGreaterThan(calls.indexOf("docker:build"));
          expect(calls.at(-1)).toBe("docker:inspect");
          expect(result.stdout).toContain('native_image_id = "1234567890123456789"');
        } else {
          expect(result.status).toBe(outcome === "container-failed" ? 9 : 1);
          expect(calls).not.toContain("docker:push");
          if (outcome === "container-failed") expect(calls).toContain("native-clean");
          expect(result.stdout).toBe("");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("release child ownership", () => {
  it("handles an empty child set under nounset with Bash 3-compatible primitives", () => {
    const helper = resolve("infra/release-child.sh");
    const source = readFileSync(helper, "utf8");
    expect(source).not.toContain("wait -n");
    expect(source).not.toContain("declare -A");
    expect(source).not.toContain("RELEASE_CHILD_COUNT");
    expect(source).not.toContain("=()");

    const shells = ["bash"];
    if (spawnSync("bash3", ["--version"], { stdio: "ignore" }).status === 0) shells.push("bash3");
    for (const shell of shells) {
      const result = spawnSync(
        shell,
        [
          "-uc",
          'source "$1"; release_stop_children; release_start_child true; release_wait_children; release_stop_children',
          "release-child-test",
          helper,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, `${shell}: ${result.stderr}`).toBe(0);
    }
  });

  it.each(["failure", "signal"])("terminates and waits for every child on %s", (mode) => {
    const root = mkdtempSync(join(tmpdir(), "pi-orb-release-children-"));
    try {
      const helper = join(root, "release-child.sh");
      const child = join(root, "child.sh");
      const runner = join(root, "runner.sh");
      const log = join(root, "calls");
      copyFileSync(resolve("infra/release-child.sh"), helper);
      writeFileSync(
        child,
        `#!/bin/bash
set -eu
log=$1
name=$2
trap 'echo "$name-cleaning" >> "$log"; sleep 0.1; echo "$name-clean" >> "$log"; exit 143' TERM
echo "$name-ready" >> "$log"
if [ "$name" = failing ]; then
  while ! grep -q sibling-ready "$log"; do sleep 0.01; done
  exit 7
fi
while :; do sleep 1; done
`,
      );
      chmodSync(child, 0o755);
      writeFileSync(
        runner,
        `#!/bin/bash
set -eu
source "$1"
log=$2
child=$3
trap 'release_stop_children; echo parent-exit >> "$log"; exit 143' TERM
if [ "$4" = failure ]; then
  release_start_child "$child" "$log" failing
  release_start_child "$child" "$log" sibling
  release_wait_children
else
  release_start_child "$child" "$log" first
  release_start_child "$child" "$log" second
  while [ "$(grep -c -- '-ready' "$log" 2>/dev/null || true)" -lt 2 ]; do sleep 0.01; done
  kill -TERM $$
fi
`,
      );
      chmodSync(runner, 0o755);

      const result = spawnSync(runner, [helper, log, child, mode], {
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(result.status, result.stderr).toBe(mode === "failure" ? 7 : 143);
      const calls = readFileSync(log, "utf8").trim().split("\n");
      const children = mode === "failure" ? ["sibling"] : ["first", "second"];
      for (const name of children) {
        expect(calls).toContain(`${name}-cleaning`);
        expect(calls).toContain(`${name}-clean`);
      }
      if (mode === "signal") {
        expect(calls.indexOf("parent-exit")).toBeGreaterThan(calls.indexOf("first-clean"));
        expect(calls.indexOf("parent-exit")).toBeGreaterThan(calls.indexOf("second-clean"));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
