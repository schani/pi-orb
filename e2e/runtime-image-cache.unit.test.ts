import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import setup from "./global-setup.ts";
import { docker } from "./harness.ts";

vi.mock("./harness.ts", () => ({ docker: vi.fn() }));

const imageId = `sha256:${"a".repeat(64)}`;
const source = readFileSync(resolve(import.meta.dirname, "../.github/workflows/e2e.yml"), "utf8");
const step = (name: string) => source.split(`- name: ${name}\n`)[1]?.split("- name:")[0];

beforeEach(() => {
  vi.stubEnv("PI_ORB_E2E_BACKEND", "docker");
  vi.stubEnv("PI_ORB_E2E_RUNTIME_IMAGE_ID", undefined);
  vi.mocked(docker).mockReset();
});

afterEach(() => vi.unstubAllEnvs());

describe("runtime image build ownership", () => {
  it("keeps the local current-tree build and ten-minute budget", async () => {
    vi.mocked(docker).mockResolvedValue("");
    await setup();
    expect(docker).toHaveBeenCalledExactlyOnceWith(
      ["build", "-f", "apps/orb-runtime/Dockerfile", "-t", "pi-orb-runtime:dev", "."],
      600_000,
    );
  });

  it("does not use Docker for the process backend", async () => {
    vi.stubEnv("PI_ORB_E2E_BACKEND", "process");
    vi.stubEnv("PI_ORB_E2E_RUNTIME_IMAGE_ID", imageId);
    await setup();
    expect(docker).not.toHaveBeenCalled();
  });

  it("verifies the exact prebuilt image instead of building twice", async () => {
    vi.stubEnv("PI_ORB_E2E_RUNTIME_IMAGE_ID", imageId);
    vi.mocked(docker).mockResolvedValue(imageId);
    await setup();
    expect(docker).toHaveBeenCalledExactlyOnceWith([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      "pi-orb-runtime:dev",
    ]);
  });

  it.each(["", "latest", "sha256:abc", `sha256:${"A".repeat(64)}`])(
    "rejects an invalid prebuilt identity %j without a fallback build",
    async (invalid) => {
      vi.stubEnv("PI_ORB_E2E_RUNTIME_IMAGE_ID", invalid);
      await expect(setup()).rejects.toThrow("PI_ORB_E2E_RUNTIME_IMAGE_ID");
      expect(docker).not.toHaveBeenCalled();
    },
  );

  it("rejects a moved tag without rebuilding or accepting an unverified image", async () => {
    vi.stubEnv("PI_ORB_E2E_RUNTIME_IMAGE_ID", imageId);
    vi.mocked(docker).mockResolvedValue(`sha256:${"b".repeat(64)}`);
    await expect(setup()).rejects.toThrow("E2E runtime image identity mismatch");
    expect(docker).toHaveBeenCalledTimes(1);
  });

  it("preserves an inspect failure without a fallback build", async () => {
    vi.stubEnv("PI_ORB_E2E_RUNTIME_IMAGE_ID", imageId);
    const failure = new Error("image missing");
    vi.mocked(docker).mockRejectedValue(failure);
    await expect(setup()).rejects.toBe(failure);
    expect(docker).toHaveBeenCalledTimes(1);
  });
});

describe("isolated runtime image build", () => {
  it("uses pinned BuildKit actions and loads the current checkout without publication", () => {
    expect(step("Set up Docker Buildx")).toContain(
      "uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069",
    );
    const build = step("Build E2E runtime image");
    expect(build).toContain("id: runtime-image");
    expect(build).toContain("timeout-minutes: 10");
    expect(build).toContain(
      "uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc",
    );
    for (const value of [
      "context: .",
      "file: apps/orb-runtime/Dockerfile",
      "load: true",
      "push: false",
      "tags: pi-orb-runtime:dev",
      "platforms: linux/amd64",
    ])
      expect(build).toContain(value);
    expect(source.indexOf("- name: Check Docker disk budget")).toBeLessThan(
      source.indexOf("- name: Build E2E runtime image"),
    );
    expect(source.indexOf("- name: Build E2E runtime image")).toBeLessThan(
      source.indexOf("- name: Run end-to-end test"),
    );
  });

  it("does not import or export a remote runtime image cache", () => {
    const build = step("Build E2E runtime image");
    expect(build).not.toMatch(/cache-from:|cache-to:/u);
    expect(step("Report runtime image build")).not.toMatch(/CACHE_WRITE|Cache:|e2e-runtime-linux/u);
    expect(source).not.toContain("pull_request_target");
    expect(source).toContain("permissions:\n  contents: read\n");
  });

  it("binds E2E to the exact loaded image with no build-record artifacts", () => {
    expect(step("Run end-to-end test")).toContain(
      `PI_ORB_E2E_RUNTIME_IMAGE_ID: \${{ steps.runtime-image.outputs.imageid }}`,
    );
    const build = step("Build E2E runtime image");
    expect(build).toContain("DOCKER_BUILD_RECORD_UPLOAD: false");
    expect(step("Report runtime image build")).toContain("steps.runtime-image.outputs.imageid");
    expect(step("Report runtime image build")).toContain("github.sha");
    expect(build).not.toMatch(/secrets:|build-args:|outputs:/u);
  });
});
