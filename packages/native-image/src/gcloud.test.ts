import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(calls[0]).toContain("--size=10GB");
    const captured = await effects.capture(buildInput, "workspace", new AbortController().signal);
    expect(captured.isOk() && captured.value.id).toBe("456");
    expect(calls.at(-1)).toContain("--source-disk=pi-orb-data-workspace-v1-0123456789abcdef");
  });
});
