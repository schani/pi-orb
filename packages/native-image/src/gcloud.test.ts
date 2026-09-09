import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type CommandRunner, GcloudImageBuildEffects } from "./gcloud.ts";
import type { ImageBuildInput } from "./orchestrator.ts";

const temporaryDirectories: string[] = [];

async function input(): Promise<ImageBuildInput> {
  const outputDir = await mkdtemp(join(tmpdir(), "pi-orb-native-image-test-"));
  temporaryDirectories.push(outputDir);
  return {
    project: "target-project",
    zone: "us-central1-a",
    baseImage: "projects/base-project/global/images/debian-pinned",
    version: "v1",
    subnetwork: "projects/target-project/regions/us-central1/subnetworks/orbs",
    builderServiceAccount: "builder@target-project",
    validationServiceAccount: "orb@target-project",
    sourceCommit: "a".repeat(40),
    sourceDirty: false,
    sourceArchiveSha256: "b".repeat(64),
    operationId: "0123456789abcdef",
    outputDir,
    validationRepositoryUrl: "https://github.com/example/repo",
    inputInventory: {},
    toolingInputInventory: {},
  };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("GCloud native-image adapter", () => {
  it("creates a private operation-owned SSH key without prompts and removes it", async () => {
    const buildInput = await input();
    const effects = new GcloudImageBuildEffects(async (command, args) =>
      command === "ssh-keygen"
        ? promisify(execFile)(command, args)
        : { stdout: "deployer", stderr: "" },
    );
    const signal = new AbortController().signal;
    expect((await effects.run("prerequisites", "check", buildInput, signal)).isOk()).toBe(true);
    const directory = `${buildInput.outputDir}/build-ssh`;
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(`${directory}/key`)).mode & 0o777).toBe(0o600);
    expect(await readFile(`${directory}/key.pub`, "utf8")).toMatch(/^ssh-ed25519 /);
    expect((await effects.run("cleanup", "delete-ssh-key", buildInput, signal)).isOk()).toBe(true);
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await effects.run("cleanup", "delete-ssh-key", buildInput, signal)).isOk()).toBe(true);
  });

  it("refuses an existing SSH directory and never deletes foreign keys", async () => {
    const buildInput = await input();
    const directory = `${buildInput.outputDir}/build-ssh`;
    await mkdir(directory);
    await writeFile(`${directory}/key`, "foreign");
    const effects = new GcloudImageBuildEffects(async () => {
      throw new Error("must not execute");
    });
    const signal = new AbortController().signal;
    expect((await effects.run("prerequisites", "check", buildInput, signal)).isErr()).toBe(true);
    expect((await effects.run("cleanup", "delete-ssh-key", buildInput, signal)).isOk()).toBe(true);
    expect(await readFile(`${directory}/key`, "utf8")).toBe("foreign");
  });

  it("does not confuse another operation's SSH directory with its own", async () => {
    const owned = await input();
    const foreign = await input();
    const effects = new GcloudImageBuildEffects(async () => ({ stdout: "deployer", stderr: "" }));
    const signal = new AbortController().signal;
    expect((await effects.run("prerequisites", "check", owned, signal)).isOk()).toBe(true);
    await mkdir(`${foreign.outputDir}/build-ssh`);
    await writeFile(`${foreign.outputDir}/build-ssh/key`, "foreign");
    expect((await effects.run("cleanup", "delete-ssh-key", foreign, signal)).isOk()).toBe(true);
    expect(await readFile(`${foreign.outputDir}/build-ssh/key`, "utf8")).toBe("foreign");
    expect((await effects.run("cleanup", "delete-ssh-key", owned, signal)).isOk()).toBe(true);
    await expect(stat(`${owned.outputDir}/build-ssh`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves key-generation failure and cleans its partially created directory", async () => {
    const buildInput = await input();
    const effects = new GcloudImageBuildEffects(async () => {
      throw new Error("ssh-keygen unavailable");
    });
    const signal = new AbortController().signal;
    const result = await effects.run("prerequisites", "check", buildInput, signal);
    expect(result.isErr() && result.error).toMatchObject({
      stage: "prerequisites",
      message: "ssh-keygen unavailable",
    });
    expect((await effects.run("cleanup", "delete-ssh-key", buildInput, signal)).isOk()).toBe(true);
    await expect(stat(`${buildInput.outputDir}/build-ssh`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses an explicit administrator, operation key and batch mode for SSH and SCP", async () => {
    const buildInput = await input();
    const calls: string[][] = [];
    const effects = new GcloudImageBuildEffects(async (_command, args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    });
    const signal = new AbortController().signal;
    for (const [stage, action] of [
      ["builder", "ready"],
      ["install", "upload"],
      ["validate", "ready"],
      ["seal", "seal"],
    ] as const)
      expect((await effects.run(stage, action, buildInput, signal)).isOk()).toBe(true);
    expect(calls).toHaveLength(4);
    for (const args of calls) {
      expect(args).toContain(`--ssh-key-file=${buildInput.outputDir}/build-ssh/key`);
      expect(args).toContain("--quiet");
      expect(args).toContain("--tunnel-through-iap");
      const scp = args[1] === "scp";
      expect(args[scp ? 3 : 2]).toMatch(/^pi-orb-build@pi-orb-(builder|validator)-/);
      expect(args).toContain(scp ? "--scp-flag=-oBatchMode=yes" : "--ssh-flag=-oBatchMode=yes");
    }
  });

  it("captures the exact image identity from the Compute response", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify([
          {
            id: "123456",
            name: "image-v1",
            selfLink:
              "https://www.googleapis.com/compute/v1/projects/target-project/global/images/image-v1",
          },
        ]),
        stderr: "",
      };
    };
    const value = await new GcloudImageBuildEffects(runner).capture(
      await input(),
      "runtime",
      new AbortController().signal,
    );
    expect(value.isOk() && value.value).toEqual({
      id: "123456",
      name: "image-v1",
      resource: "projects/target-project/global/images/image-v1",
    });
    expect(calls[0]).toContain("--source-disk-zone=us-central1-a");
    expect(calls[0]).toContain(
      "--labels=pi-orb-native-build=0123456789abcdef,pi-orb-native-version=v1",
    );
  });

  it("forces builder SSH keys into instance metadata", async () => {
    const calls: string[][] = [];
    const effects = new GcloudImageBuildEffects(async (_command, args) => {
      calls.push(args);
      return { stdout: "[]", stderr: "" };
    });
    const value = await effects.run(
      "builder",
      "create",
      await input(),
      new AbortController().signal,
    );
    expect(value.isOk()).toBe(true);
    expect(calls[0]).toContain("--metadata=block-project-ssh-keys=TRUE");
  });

  it("maps malformed capture JSON to a typed failure", async () => {
    const effects = new GcloudImageBuildEffects(async () => ({ stdout: "not-json", stderr: "" }));
    const value = await effects.capture(await input(), "runtime", new AbortController().signal);
    expect(value.isErr() && value.error).toMatchObject({
      type: "image_build_failed",
      stage: "capture",
    });
  });

  it("rejects malformed singleton image fields", async () => {
    const effects = new GcloudImageBuildEffects(async () => ({
      stdout: JSON.stringify([{ id: 123, name: "image-v1" }]),
      stderr: "",
    }));
    const value = await effects.capture(await input(), "runtime", new AbortController().signal);
    expect(value.isErr() && value.error.message).toBe("invalid image response shape");
  });

  it("refuses to delete a foreign resource", async () => {
    const calls: string[][] = [];
    const effects = new GcloudImageBuildEffects(async (_command, args) => {
      calls.push(args);
      if (args[1] === "operations") return { stdout: "[]", stderr: "" };
      return {
        stdout: JSON.stringify({
          name: "pi-orb-builder-v1-0123456789abcdef",
          labels: { "pi-orb-native-build": "another-owner" },
        }),
        stderr: "",
      };
    });
    const value = await effects.run(
      "cleanup",
      "delete-builder",
      await input(),
      new AbortController().signal,
    );
    expect(value.isErr() && value.error.message).toContain("refusing to delete foreign");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("--format=json(name,labels)");
  });

  it("deletes only after the ownership label matches", async () => {
    const calls: string[][] = [];
    const effects = new GcloudImageBuildEffects(async (_command, args) => {
      calls.push(args);
      if (args[1] === "operations") return { stdout: "[]", stderr: "" };
      return {
        stdout:
          args[2] === "describe"
            ? JSON.stringify({
                name: "pi-orb-builder-v1-0123456789abcdef",
                labels: { "pi-orb-native-build": "0123456789abcdef" },
              })
            : "",
        stderr: "",
      };
    });
    const value = await effects.run(
      "cleanup",
      "delete-builder",
      await input(),
      new AbortController().signal,
    );
    expect(value.isOk()).toBe(true);
    expect(calls[2]?.slice(0, 3)).toEqual(["compute", "instances", "delete"]);
  });

  it("waits for an exact late create operation before owned cleanup", async () => {
    const calls: string[][] = [];
    let materialized = false;
    const name = "pi-orb-image-workspace-v1-0123456789abcdef";
    const effects = new GcloudImageBuildEffects(async (_command, args) => {
      calls.push(args);
      if (args[1] === "operations" && args[2] === "list") {
        return {
          stdout: JSON.stringify([
            {
              name: "operation-late-workspace-image",
              status: "RUNNING",
              targetLink: `https://www.googleapis.com/compute/v1/projects/target-project/global/images/${name}`,
            },
          ]),
          stderr: "",
        };
      }
      if (args[1] === "operations" && args[2] === "describe") {
        materialized = true;
        return { stdout: "DONE\n", stderr: "" };
      }
      if (args[2] === "describe") {
        if (!materialized) throw new Error(`${name} was not found`);
        return {
          stdout: JSON.stringify({
            name,
            labels: { "pi-orb-native-build": "0123456789abcdef" },
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    const value = await effects.run(
      "cleanup",
      "delete-workspace-image",
      await input(),
      new AbortController().signal,
    );
    expect(value.isOk()).toBe(true);
    expect(calls.map((args) => args.slice(0, 3))).toEqual([
      ["compute", "operations", "list"],
      ["compute", "operations", "describe"],
      ["compute", "images", "describe"],
      ["compute", "images", "delete"],
    ]);
    expect(calls[1]).toContain("--global");
  });

  it("fails cleanup when an exact operation cannot be described", async () => {
    let deleted = false;
    const effects = new GcloudImageBuildEffects(async (_command, args) => {
      if (args[1] === "operations" && args[2] === "list") {
        return {
          stdout: JSON.stringify([
            {
              name: "operation-late-workspace-image",
              status: "RUNNING",
              targetLink:
                "projects/target-project/global/images/pi-orb-image-workspace-v1-0123456789abcdef",
            },
          ]),
          stderr: "",
        };
      }
      if (args[1] === "operations" && args[2] === "describe")
        throw new Error("operation status unavailable");
      if (args[2] === "delete") deleted = true;
      return { stdout: "", stderr: "" };
    });
    const value = await effects.run(
      "cleanup",
      "delete-workspace-image",
      await input(),
      new AbortController().signal,
    );
    expect(value.isErr() && value.error.message).toContain("operation status unavailable");
    expect(deleted).toBe(false);
  });

  it("classifies transient readiness and permanent install failure", async () => {
    const transient = new GcloudImageBuildEffects(async () => {
      throw new Error("ssh unavailable");
    });
    const transientResult = await transient.run(
      "builder",
      "ready",
      await input(),
      new AbortController().signal,
    );
    expect(transientResult.isErr() && transientResult.error.retryable).toBe(true);

    const installTransientResult = await transient.run(
      "install",
      "complete",
      await input(),
      new AbortController().signal,
    );
    expect(installTransientResult.isErr() && installTransientResult.error.retryable).toBe(true);

    const terminal = new GcloudImageBuildEffects(async () => ({
      stdout: "PI_ORB_TERMINAL\n",
      stderr: "",
    }));
    const terminalResult = await terminal.run(
      "install",
      "complete",
      await input(),
      new AbortController().signal,
    );
    expect(terminalResult.isErr() && terminalResult.error.retryable).toBeUndefined();
  });

  it("queries the base image in its owning project", async () => {
    const calls: string[][] = [];
    const effects = new GcloudImageBuildEffects(async (_command, args) => {
      calls.push(args);
      return { stdout: "9876\n", stderr: "" };
    });
    const value = await effects.resolveBaseImageId(await input(), new AbortController().signal);
    expect(value.isOk() && value.value).toBe("9876");
    expect(calls[0]).toEqual([
      "compute",
      "images",
      "describe",
      "debian-pinned",
      "--project=base-project",
      "--format=value(id)",
    ]);
  });

  it("describes the base image once across prerequisites and identity resolution", async () => {
    const calls: string[][] = [];
    const effects = new GcloudImageBuildEffects(async (_command, args) => {
      calls.push(args);
      return { stdout: args[0] === "auth" ? "builder@example.com\n" : "9876\n", stderr: "" };
    });
    const buildInput = await input();
    expect(
      (
        await effects.run("prerequisites", "check", buildInput, new AbortController().signal)
      ).isOk(),
    ).toBe(true);
    expect(
      (await effects.resolveBaseImageId(buildInput, new AbortController().signal)).isOk(),
    ).toBe(true);
    expect(calls.filter((args) => args[1] === "images" && args[2] === "describe")).toHaveLength(1);
  });

  it("verifies the builder boot disk's numeric source-image identity", async () => {
    const calls: string[][] = [];
    const effects = new GcloudImageBuildEffects(async (_command, args) => {
      calls.push(args);
      return { stdout: "9876\n", stderr: "" };
    });
    const value = await effects.verifyBuilderBaseImage(
      await input(),
      "9876",
      new AbortController().signal,
    );
    expect(value.isOk()).toBe(true);
    expect(calls[0]?.slice(0, 3)).toEqual(["compute", "disks", "describe"]);
    expect(calls[0]).toContain("--format=value(sourceImageId)");
  });

  it("verifies the validation disk's workspace-image identity", async () => {
    const calls: string[][] = [];
    const effects = new GcloudImageBuildEffects(async (_command, args) => {
      calls.push(args);
      return { stdout: "4567\n", stderr: "" };
    });
    const value = await effects.verifyValidationWorkspaceImage(
      await input(),
      "4567",
      new AbortController().signal,
    );
    expect(value.isOk()).toBe(true);
    expect(calls[0]).toContain("--format=value(sourceImageId)");
    expect(calls[0]).toContain("pi-orb-data-v1-0123456789abcdef");
  });

  it("boots validation with its loopback broker startup fixture", async () => {
    const calls: string[][] = [];
    const buildInput = await input();
    const effects = new GcloudImageBuildEffects(async (_command, args) => {
      calls.push(args);
      return { stdout: "[]", stderr: "" };
    });
    const value = await effects.run("validate", "create", buildInput, new AbortController().signal);
    expect(value.isOk()).toBe(true);
    const config = JSON.parse(
      await readFile(`${buildInput.outputDir}/validation-config.json`, "utf8"),
    );
    expect(config.PI_ORB_CONTROL_PLANE_URL).toBe("http://127.0.0.1:18080");
    expect(config.PI_ORB_SKILLS_DIR).toBe("/opt/pi-orb/skills");
    const startup = await readFile(`${buildInput.outputDir}/validation-startup.sh`, "utf8");
    expect(startup).toContain("pi-orb-validation-broker");
    expect(startup).toContain("systemctl restart pi-orb-runtime.service");
    expect(calls[1]).toContain(
      `--metadata-from-file=pi-orb-config=${buildInput.outputDir}/validation-config.json,startup-script=${buildInput.outputDir}/validation-startup.sh`,
    );
    expect(calls[1]).toContain(
      "--metadata=enable-guest-attributes=TRUE,block-project-ssh-keys=TRUE",
    );
    expect(calls[0]).toContain("--image=pi-orb-image-workspace-v1-0123456789abcdef");
    expect(calls[0]).toContain("--size=50GB");
  });

  it("creates and captures an owned empty workspace template", async () => {
    const calls: string[][] = [];
    const effects = new GcloudImageBuildEffects(async (_command, args) => {
      calls.push(args);
      return {
        stdout:
          args.includes("create") && args.includes("images")
            ? JSON.stringify([
                {
                  id: "456",
                  name: "pi-orb-image-workspace-v1-0123456789abcdef",
                  selfLink:
                    "https://www.googleapis.com/compute/v1/projects/target-project/global/images/pi-orb-image-workspace-v1-0123456789abcdef",
                },
              ])
            : "[]",
        stderr: "",
      };
    });
    const buildInput = await input();
    expect(
      (
        await effects.run(
          "capture",
          "create-workspace-disk",
          buildInput,
          new AbortController().signal,
        )
      ).isOk(),
    ).toBe(true);
    expect(calls[0]).toContain("pi-orb-data-workspace-v1-0123456789abcdef");
    expect(calls[0]).toContain("--size=50GB");
    expect(
      (
        await effects.run(
          "capture",
          "format-workspace-disk",
          buildInput,
          new AbortController().signal,
        )
      ).isOk(),
    ).toBe(true);
    const format = calls.at(-1)?.find((arg) => arg.startsWith("--command=")) ?? "";
    expect(format).toContain('sudo e2fsck -f -n "$disk"');
    expect(format.indexOf('sudo umount "$mount_dir"')).toBeLessThan(format.indexOf("sudo e2fsck"));
    expect(format).not.toContain("resize2fs");
    const captured = await effects.capture(buildInput, "workspace", new AbortController().signal);
    expect(captured.isOk() && captured.value.id).toBe("456");
    expect(calls.at(-1)).toContain("--source-disk=pi-orb-data-workspace-v1-0123456789abcdef");
  });
});
