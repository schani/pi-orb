import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = (name: string) =>
  readFileSync(resolve(import.meta.dirname, `../.github/workflows/${name}.yml`), "utf8");
const source = workflow("ci");
const job = source.split("\n  control-plane-image:\n")[1]?.split(/^ {2}[\w-]+:/mu)[0] ?? "";
const step = (name: string) => job.split(`- name: ${name}\n`)[1]?.split("- name:")[0] ?? "";
const proof = step("Prove packaged worker, Git and skills without network")
  .split("        run: |\n")[1]
  ?.replace(/^ {10}/gmu, "");
const imageId = `sha256:${"a".repeat(64)}`;

describe("consolidated control-plane image qualification", () => {
  it("keeps one required image job and its artifact guard and 15 GiB budget", () => {
    expect(job).not.toBe("");
    expect(workflow("durable-qualification")).not.toContain("\n  control-plane-image:");
    expect(job).not.toMatch(/^ {4}(?:name|if|needs):/mu);
    expect(step("Reject tracked deployment credentials, plans and state")).toContain(
      "run: python3 infra/artifact_guard.py",
    );
    expect(step("Check image-build disk headroom")).toContain(
      "available >= 15 * 1024 * 1024 * 1024",
    );
    expect(job.indexOf("- name: Check image-build disk headroom")).toBeLessThan(
      job.indexOf("- name: Build control-plane image"),
    );
  });

  it("loads the current checkout using the pinned Buildx actions without publishing", () => {
    expect(step("Set up Docker Buildx")).toContain(
      "uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f",
    );
    const build = step("Build control-plane image");
    for (const value of [
      "id: control-plane-image",
      "uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8",
      "DOCKER_BUILD_RECORD_UPLOAD: false",
      "context: .",
      "file: apps/control-plane/Dockerfile",
      "platforms: linux/amd64",
      "load: true",
      "push: false",
      "cache-from: type=gha,scope=control-plane-linux-amd64-v1",
    ])
      expect(build).toContain(value);
    expect(build).not.toMatch(/secrets:|build-args:|outputs:/u);
    expect(job).not.toMatch(/docker build|google-github-actions\/auth|id-token:|secrets\./u);
  });

  it("exports cache only on push/main; PR and manual events only import", () => {
    expect(step("Build control-plane image").match(/cache-to: (.+)/u)?.[1]).toBe(
      `\${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && 'type=gha,scope=control-plane-linux-amd64-v1,mode=max' || '' }}`,
    );
    expect(job.match(/cache-to:/gu)).toHaveLength(1);
    expect(source).not.toContain("pull_request_target");
    expect(source).toContain("permissions:\n  contents: read\n");
  });

  it("proves the exact returned local image without network, tag fallback or host mounts", () => {
    const prove = step("Prove packaged worker, Git and skills without network");
    expect(prove).toContain(`IMAGE_ID: \${{ steps.control-plane-image.outputs.imageid }}`);
    expect(prove).toContain('docker create --network none "$IMAGE_ID" node /app/image-proof.mjs');
    expect(prove).toContain(
      'docker cp scripts/control-plane-image-proof.mjs "$container:/app/image-proof.mjs"',
    );
    expect(prove).toContain("trap 'docker rm -f \"$container\"' EXIT");
    expect(prove).toContain("set -euo pipefail");
    expect(prove).toContain("docker inspect --format '{{.State.ExitCode}}'");
    expect(prove).not.toMatch(
      /pi-orb-control-plane:|--mount|--volume|--pull|docker (?:build|pull)|\|\| true/u,
    );
    expect(job.indexOf("- name: Build control-plane image")).toBeLessThan(
      job.indexOf("- name: Prove packaged worker, Git and skills without network"),
    );
  });

  it("always retains proof and checkout/image/cache provenance with pinned upload", () => {
    const report = step("Report image and disk provenance");
    for (const value of [
      "if: always()",
      "github.sha",
      "steps.control-plane-image.outputs.imageid",
      "control-plane-linux-amd64-v1",
      "docker system df",
      "docker image inspect",
      "GITHUB_STEP_SUMMARY",
      "control-plane-image-provenance.log",
    ])
      expect(report).toContain(value);
    const upload = step("Upload image proof");
    for (const value of [
      "if: always()",
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      `control-plane-image-\${{ github.run_id }}-\${{ github.run_attempt }}`,
      "control-plane-image-proof.log",
      "control-plane-image-provenance.log",
      "if-no-files-found: ignore",
      "retention-days: 14",
    ])
      expect(upload).toContain(value);
  });
});

function runProof(image: string, exitCode = "0", startExit = "0", inspectedId = image) {
  expect(proof).toBeDefined();
  const directory = mkdtempSync(resolve(tmpdir(), "cp-image-proof-"));
  try {
    return spawnSync(
      "bash",
      [
        "-c",
        `
docker() {
  printf 'DOCKER %s\\n' "$*" >&2
  case "$1 $2" in
    "image inspect") printf '%s\\n' "$INSPECTED_ID";;
    "create --network") printf 'container-id\\n';;
    "start --attach") printf 'proof output\\n'; return "$START_EXIT";;
    "inspect --format") printf '%s\\n' "$PROOF_EXIT";;
  esac
}
${proof}`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          IMAGE_ID: image,
          INSPECTED_ID: inspectedId,
          PROOF_EXIT: exitCode,
          START_EXIT: startExit,
          RUNNER_TEMP: directory,
        },
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("image proof fail-closed shell", () => {
  it("accepts a successful proof against the returned image ID", () => {
    const result = runProof(imageId);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("proof output");
    expect(result.stderr).toContain(
      `DOCKER create --network none ${imageId} node /app/image-proof.mjs`,
    );
    expect(result.stderr).toContain("DOCKER rm -f container-id");
  });

  it.each(["", "latest", "sha256:abc"])("rejects invalid identity %j before Docker", (invalid) => {
    const result = runProof(invalid);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("DOCKER ");
  });

  it("rejects an unavailable local image without creating a container or rebuilding", () => {
    const result = runProof(imageId, "0", "0", "");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DOCKER image inspect");
    expect(result.stderr).not.toContain("DOCKER create");
    expect(result.stderr).not.toMatch(/DOCKER (build|pull)/u);
  });

  it("propagates the container exit code even when attach succeeds", () => {
    const result = runProof(imageId, "7");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DOCKER inspect --format {{.State.ExitCode}} container-id");
    expect(result.stderr).toContain("DOCKER rm -f container-id");
  });

  it("does not swallow attach failures and always removes its container", () => {
    const result = runProof(imageId, "0", "9");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DOCKER rm -f container-id");
  });
});
