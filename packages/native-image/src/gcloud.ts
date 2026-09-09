import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import type {
  CapturedImage,
  ImageBuildEffects,
  ImageBuildError,
  ImageBuildInput,
  ImageBuildManifest,
  ImageBuildStage,
} from "./orchestrator.ts";
import { validationStartupScript } from "./validation-broker.ts";

const execFileAsync = promisify(execFile);

type RunResult = { readonly stdout: string; readonly stderr: string };
export type CommandRunner = (
  command: string,
  args: string[],
  options: { signal: AbortSignal; maxBuffer: number; timeout: number; killSignal: NodeJS.Signals },
) => Promise<RunResult>;
export interface CleanupTiming {
  now(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export class GcloudImageBuildEffects implements ImageBuildEffects {
  private commandNumber = 0;
  private readonly sshDirectoriesOwned = new Set<string>();
  private readonly commandRunner: CommandRunner;
  private readonly cleanupTiming: CleanupTiming;

  constructor(
    commandRunner: CommandRunner = execFileAsync,
    cleanupTiming: CleanupTiming = {
      now: Date.now,
      wait: (milliseconds, signal) => setTimeout(milliseconds, undefined, { signal }),
    },
  ) {
    this.commandRunner = commandRunner;
    this.cleanupTiming = cleanupTiming;
  }

  now(): string {
    return new Date().toISOString();
  }

  private name(
    input: ImageBuildInput,
    kind: "builder" | "validator" | "data" | "image" | "workspace-disk" | "workspace-image",
  ): string {
    const suffix = input.operationId
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 16);
    const reserved = `pi-orb-${kind}--${suffix}`.length;
    const version = input.version.slice(0, 63 - reserved).replace(/-$/, "");
    const prefix =
      kind === "workspace-image"
        ? "image-workspace"
        : kind === "workspace-disk"
          ? "data-workspace"
          : kind;
    return `pi-orb-${prefix}-${version}-${suffix}`;
  }

  private labels(input: ImageBuildInput): string {
    return `pi-orb-native-build=${input.operationId},pi-orb-native-version=${input.version}`;
  }

  private baseImageDescribeArgs(input: ImageBuildInput): string[] {
    const parts = input.baseImage.split("/");
    return ["compute", "images", "describe", parts[4] ?? "", `--project=${parts[1] ?? ""}`];
  }

  private execute(
    input: ImageBuildInput,
    stage: ImageBuildStage,
    command: string,
    args: string[],
    signal: AbortSignal,
    timeout = 300_000,
  ): ResultAsync<RunResult, ImageBuildError> {
    const sequence = String(++this.commandNumber).padStart(3, "0");
    return ResultAsync.fromPromise(
      (async (): Promise<Result<RunResult, ImageBuildError>> => {
        let outcome: Result<RunResult, ImageBuildError>;
        let output: RunResult;
        try {
          output = await this.commandRunner(command, args, {
            signal,
            maxBuffer: 16 * 1024 * 1024,
            timeout,
            killSignal: "SIGKILL",
          });
          outcome = ok(output);
        } catch (cause) {
          const failure = cause as Error & { stdout?: string; stderr?: string };
          output = { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
          outcome = err({
            type: signal.aborted ? "cancelled" : "image_build_failed",
            stage,
            message: failure.message,
          });
        }
        await mkdir(input.outputDir, { recursive: true });
        await writeFile(
          `${input.outputDir}/${sequence}-${stage}-${command.replaceAll("/", "-")}.log`,
          `$ ${command} ${args.join(" ")}\n${output.stdout}${output.stderr}`,
          { mode: 0o600 },
        );
        return outcome;
      })(),
      (cause): ImageBuildError => ({
        type: "image_build_failed",
        stage,
        message: `failed to preserve command log: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    ).andThen((outcome) => outcome);
  }

  private gcloud(
    input: ImageBuildInput,
    stage: ImageBuildStage,
    args: string[],
    signal: AbortSignal,
    timeout?: number,
  ): ResultAsync<RunResult, ImageBuildError> {
    return this.execute(input, stage, "gcloud", args, signal, timeout);
  }

  private ssh(
    input: ImageBuildInput,
    stage: ImageBuildStage,
    instance: string,
    remoteCommand: string,
    signal: AbortSignal,
  ): ResultAsync<RunResult, ImageBuildError> {
    return this.gcloud(
      input,
      stage,
      [
        "compute",
        "ssh",
        `pi-orb-build@${instance}`,
        `--ssh-key-file=${input.outputDir}/build-ssh/key`,
        "--quiet",
        "--ssh-flag=-oBatchMode=yes",
        `--project=${input.project}`,
        `--zone=${input.zone}`,
        "--tunnel-through-iap",
        `--command=${remoteCommand}`,
      ],
      signal,
    );
  }

  run(
    stage: ImageBuildStage,
    action: string,
    input: ImageBuildInput,
    signal: AbortSignal,
  ): ResultAsync<void, ImageBuildError> {
    const builder = this.name(input, "builder");
    const validator = this.name(input, "validator");
    const data = this.name(input, "data");
    const image = this.name(input, "image");
    const workspaceDisk = this.name(input, "workspace-disk");
    const workspaceImage = this.name(input, "workspace-image");
    const common = [`--project=${input.project}`, `--zone=${input.zone}`];
    switch (`${stage}:${action}`) {
      case "cleanup:delete-ssh-key":
        return this.sshDirectoriesOwned.has(input.outputDir)
          ? ResultAsync.fromPromise(
              rm(`${input.outputDir}/build-ssh`, { recursive: true, force: true }),
              (cause): ImageBuildError => ({
                type: "image_build_failed",
                stage,
                message: `failed to remove build SSH key: ${String(cause)}`,
              }),
            ).map(() => {
              this.sshDirectoriesOwned.delete(input.outputDir);
              return undefined;
            })
          : okAsync(undefined);
      case "prerequisites:check":
        return ResultAsync.fromPromise(
          mkdir(`${input.outputDir}/build-ssh`, { mode: 0o700 }),
          (cause): ImageBuildError => ({
            type: "image_build_failed",
            stage,
            message: `failed to create private build SSH directory: ${String(cause)}`,
          }),
        )
          .andThen(() => {
            this.sshDirectoriesOwned.add(input.outputDir);
            return this.execute(
              input,
              stage,
              "ssh-keygen",
              [
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-C",
                "pi-orb-build",
                "-f",
                `${input.outputDir}/build-ssh/key`,
              ],
              signal,
            );
          })
          .andThen(() => this.execute(input, stage, "tar", ["--version"], signal))
          .andThen(() =>
            this.gcloud(
              input,
              stage,
              ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"],
              signal,
            ),
          )
          .andThen((value) =>
            value.stdout.trim()
              ? okAsync<void, ImageBuildError>(undefined)
              : errAsync<void, ImageBuildError>({
                  type: "image_build_failed",
                  stage,
                  message: "gcloud has no active account",
                }),
          );
      case "builder:create":
        return this.gcloud(
          input,
          stage,
          [
            "compute",
            "instances",
            "create",
            builder,
            ...common,
            "--machine-type=n2d-highmem-4",
            `--subnet=${input.subnetwork}`,
            `--service-account=${input.builderServiceAccount}`,
            "--scopes=https://www.googleapis.com/auth/cloud-platform",
            `--image=${input.baseImage}`,
            "--boot-disk-size=20GB",
            "--metadata=block-project-ssh-keys=TRUE",
            `--labels=${this.labels(input)}`,
            "--format=json",
          ],
          signal,
        ).map(() => undefined);
      case "builder:ready":
        return this.ssh(input, stage, builder, "true", signal)
          .map(() => undefined)
          .mapErr((failure) => ({ ...failure, retryable: true as const }));
      case "install:upload":
        return this.gcloud(
          input,
          stage,
          [
            "compute",
            "scp",
            `${input.outputDir}/source.tar.gz`,
            `pi-orb-build@${builder}:source.tar.gz`,
            ...common,
            `--ssh-key-file=${input.outputDir}/build-ssh/key`,
            "--quiet",
            "--scp-flag=-oBatchMode=yes",
            "--tunnel-through-iap",
          ],
          signal,
        ).map(() => undefined);
      case "install:run":
        return this.ssh(
          input,
          stage,
          builder,
          "set -eu; sudo mkdir -p /app; sudo tar -xzf source.tar.gz -C /app; sudo systemd-run --unit=pi-orb-image-build /bin/bash -c 'cd /app && exec infra/native-vm/install.sh >/var/log/pi-orb-image-build.log 2>&1'",
          signal,
        ).map(() => undefined);
      case "install:complete":
        return this.ssh(
          input,
          stage,
          builder,
          "if test -f /opt/pi-orb/build-finished-at; then echo PI_ORB_COMPLETE; elif systemctl is-failed --quiet pi-orb-image-build.service; then echo PI_ORB_TERMINAL; else echo PI_ORB_PENDING; fi",
          signal,
        )
          .mapErr((failure) => ({ ...failure, retryable: true as const }))
          .andThen((result) =>
            result.stdout.includes("PI_ORB_COMPLETE")
              ? okAsync<void, ImageBuildError>(undefined)
              : result.stdout.includes("PI_ORB_TERMINAL")
                ? errAsync<void, ImageBuildError>({
                    type: "image_build_failed",
                    stage,
                    message: "guest image installation failed",
                  })
                : errAsync<void, ImageBuildError>({
                    type: "image_build_failed",
                    stage,
                    message: "guest image installation is still running",
                    retryable: true,
                  }),
          );
      case "seal:seal":
        return this.ssh(
          input,
          stage,
          builder,
          `set -eu; echo '${input.version}' | sudo tee /opt/pi-orb/image-version >/dev/null; sudo /app/infra/native-vm/seal.sh`,
          signal,
        ).map(() => undefined);
      case "capture:create-workspace-disk":
        return this.gcloud(
          input,
          stage,
          [
            "compute",
            "disks",
            "create",
            workspaceDisk,
            ...common,
            "--size=50GB",
            "--type=pd-balanced",
            `--labels=${this.labels(input)}`,
            "--format=json",
          ],
          signal,
        ).map(() => undefined);
      case "capture:attach-workspace-disk":
        return this.gcloud(
          input,
          stage,
          [
            "compute",
            "instances",
            "attach-disk",
            builder,
            ...common,
            `--disk=${workspaceDisk}`,
            "--device-name=pi-orb-workspace-template",
          ],
          signal,
        ).map(() => undefined);
      case "capture:format-workspace-disk":
        return this.ssh(
          input,
          stage,
          builder,
          'set -eu; disk=/dev/disk/by-id/google-pi-orb-workspace-template; test -b "$disk"; filesystem=; if filesystem=$(sudo blkid -p -o value -s TYPE "$disk"); then test -z "$filesystem"; else test $? -eq 2; fi; sudo mkfs.ext4 -F -L pi-orb-workspace "$disk"; mount_dir=$(mktemp -d); sudo mount "$disk" "$mount_dir"; test -z "$(sudo find "$mount_dir" -mindepth 1 -maxdepth 1 ! -name lost+found -print -quit)"; sudo umount "$mount_dir"; rmdir "$mount_dir"; sudo e2fsck -f -n "$disk"',
          signal,
        ).map(() => undefined);
      case "capture:detach-workspace-disk":
        return this.gcloud(
          input,
          stage,
          [
            "compute",
            "instances",
            "detach-disk",
            builder,
            ...common,
            "--device-name=pi-orb-workspace-template",
          ],
          signal,
        ).map(() => undefined);
      case "capture:stop-builder":
        return this.gcloud(
          input,
          stage,
          ["compute", "instances", "stop", builder, ...common, "--quiet"],
          signal,
        ).map(() => undefined);
      case "validate:create": {
        const runtimeToken = `validation-${input.operationId}`;
        return this.gcloud(
          input,
          stage,
          [
            "compute",
            "disks",
            "create",
            data,
            ...common,
            "--size=50GB",
            "--type=pd-balanced",
            `--image=${workspaceImage}`,
            `--labels=${this.labels(input)}`,
            "--format=json",
          ],
          signal,
        )
          .andThen(() =>
            ResultAsync.fromPromise(
              writeFile(
                `${input.outputDir}/validation-config.json`,
                `${JSON.stringify({ PI_ORB_ID: `image-validation-${input.operationId}`, PI_ORB_RUNTIME_TOKEN: runtimeToken, PI_ORB_CONTROL_PLANE_URL: "http://127.0.0.1:18080", PI_ORB_HOST_INCARNATION: "0", PI_ORB_REPOSITORY_URL: input.validationRepositoryUrl, PI_ORB_SKILLS_DIR: "/opt/pi-orb/skills" })}\n`,
                { mode: 0o600 },
              ),
              (cause): ImageBuildError => ({
                type: "image_build_failed",
                stage,
                message: String(cause),
              }),
            ),
          )
          .andThen(() =>
            ResultAsync.fromPromise(
              writeFile(
                `${input.outputDir}/validation-startup.sh`,
                validationStartupScript(runtimeToken),
                { mode: 0o600 },
              ),
              (cause): ImageBuildError => ({
                type: "image_build_failed",
                stage,
                message: String(cause),
              }),
            ),
          )
          .andThen(() =>
            this.gcloud(
              input,
              stage,
              [
                "compute",
                "instances",
                "create",
                validator,
                ...common,
                "--machine-type=e2-standard-4",
                `--subnet=${input.subnetwork}`,
                `--service-account=${input.validationServiceAccount}`,
                "--scopes=https://www.googleapis.com/auth/logging.write",
                `--image=${image}`,
                `--disk=name=${data},device-name=pi-orb-data,auto-delete=no`,
                `--metadata-from-file=pi-orb-config=${input.outputDir}/validation-config.json,startup-script=${input.outputDir}/validation-startup.sh`,
                "--metadata=enable-guest-attributes=TRUE,block-project-ssh-keys=TRUE",
                `--labels=${this.labels(input)}`,
                "--format=json",
              ],
              signal,
            ),
          )
          .map(() => undefined);
      }
      case "validate:ready":
        return this.ssh(input, stage, validator, "true", signal)
          .map(() => undefined)
          .mapErr((failure) => ({ ...failure, retryable: true as const }));
      case "validate:probe":
        return this.ssh(
          input,
          stage,
          validator,
          `set -eu; test "$(cat /opt/pi-orb/image-version)" = '${input.version}'; test ! -e /run/pi-orb-validation-broker-unrecognized; sudo /opt/pi-orb/acceptance.sh; test ! -e /run/pi-orb-validation-broker-unrecognized`,
          signal,
        )
          .map(() => undefined)
          .mapErr((failure) => ({ ...failure, retryable: true as const }));
      case "validate:cloud-log":
        return this.gcloud(
          input,
          stage,
          ["compute", "instances", "describe", validator, ...common, "--format=value(id)"],
          signal,
        )
          .andThen((identity) =>
            this.gcloud(
              input,
              stage,
              [
                "logging",
                "read",
                `logName="projects/${input.project}/logs/pi-orb-boot" AND resource.labels.instance_id="${identity.stdout.trim()}" AND jsonPayload.phase="runtime" AND jsonPayload.status="ready"`,
                `--project=${input.project}`,
                "--limit=1",
                "--format=value(timestamp)",
              ],
              signal,
            ),
          )
          .andThen((result) =>
            result.stdout.trim()
              ? okAsync<void, ImageBuildError>(undefined)
              : errAsync<void, ImageBuildError>({
                  type: "image_build_failed",
                  stage,
                  message: "runtime-ready Cloud Logging record is not visible yet",
                  retryable: true,
                }),
          );
      case "cleanup:collect-evidence":
        return this.ssh(
          input,
          stage,
          builder,
          "sudo cat /var/log/pi-orb-image-build.log; sudo journalctl -u pi-orb-image-build --no-pager",
          signal,
        )
          .orElse(() => okAsync({ stdout: "", stderr: "" }))
          .andThen(() =>
            this.gcloud(
              input,
              stage,
              ["compute", "instances", "get-serial-port-output", builder, ...common, "--port=1"],
              signal,
            ),
          )
          .orElse(() => okAsync({ stdout: "", stderr: "" }))
          .andThen(() =>
            this.gcloud(
              input,
              stage,
              ["compute", "instances", "get-serial-port-output", validator, ...common, "--port=1"],
              signal,
            ).orElse(() => okAsync({ stdout: "", stderr: "" })),
          )
          .map(() => undefined);
      case "cleanup:delete-validator":
        return this.deleteOwned(input, "instances", validator, signal);
      case "cleanup:delete-builder":
        return this.deleteOwned(input, "instances", builder, signal);
      case "cleanup:delete-image":
        return this.deleteOwned(input, "images", image, signal);
      case "cleanup:delete-workspace-image":
        return this.deleteOwned(input, "images", workspaceImage, signal);
      case "cleanup:delete-data":
        return this.deleteOwned(input, "disks", data, signal);
      case "cleanup:delete-workspace-disk":
        return this.deleteOwned(input, "disks", workspaceDisk, signal);
      default:
        return errAsync({ type: "image_build_failed", stage, message: `unknown action ${action}` });
    }
  }

  wait(
    _input: ImageBuildInput,
    stage: ImageBuildStage,
    signal: AbortSignal,
  ): ResultAsync<void, ImageBuildError> {
    return ResultAsync.fromPromise(setTimeout(5_000, undefined, { signal }), (cause) => ({
      type: signal.aborted ? "cancelled" : "image_build_failed",
      stage,
      message: String(cause),
    }));
  }

  private deleteOwned(
    input: ImageBuildInput,
    kind: "instances" | "disks" | "images",
    name: string,
    signal: AbortSignal,
  ): ResultAsync<void, ImageBuildError> {
    const stage = "cleanup" as const;
    const scope =
      kind === "images"
        ? [`--project=${input.project}`]
        : [`--project=${input.project}`, `--zone=${input.zone}`];
    const notFound = (failure: ImageBuildError): boolean =>
      failure.message.includes("not found") || failure.message.includes("was not found");
    const describe = (): ResultAsync<"absent" | "owned", ImageBuildError> =>
      this.gcloud(
        input,
        stage,
        ["compute", kind, "describe", name, ...scope, "--format=json(name,labels)"],
        signal,
      )
        .andThen((description) =>
          Result.fromThrowable(
            () => JSON.parse(description.stdout) as unknown,
            (cause): ImageBuildError => ({
              type: "image_build_failed",
              stage,
              message: `invalid ${kind} description: ${String(cause)}`,
            }),
          )().andThen((value) => {
            const body = value as { name?: unknown; labels?: unknown };
            const labels = body?.labels as Record<string, unknown> | undefined;
            if (body?.name !== name || labels?.["pi-orb-native-build"] !== input.operationId) {
              return err<"owned", ImageBuildError>({
                type: "image_build_failed",
                stage,
                message: `refusing to delete foreign ${kind} ${name}`,
              });
            }
            return ok<"owned", ImageBuildError>("owned");
          }),
        )
        .orElse((failure) =>
          notFound(failure) ? okAsync<"absent", ImageBuildError>("absent") : errAsync(failure),
        );
    return this.waitForTargetOperations(input, kind, name, signal).andThen(() =>
      describe().andThen((observation) =>
        observation === "absent"
          ? okAsync<void, ImageBuildError>(undefined)
          : this.gcloud(
              input,
              stage,
              ["compute", kind, "delete", name, ...scope, "--quiet"],
              signal,
            ).map(() => undefined),
      ),
    );
  }

  private waitForTargetOperations(
    input: ImageBuildInput,
    kind: "instances" | "disks" | "images",
    name: string,
    signal: AbortSignal,
  ): ResultAsync<void, ImageBuildError> {
    const stage = "cleanup" as const;
    const target =
      kind === "images"
        ? `projects/${input.project}/global/images/${name}`
        : `projects/${input.project}/zones/${input.zone}/${kind}/${name}`;
    const deadline = this.cleanupTiming.now() + 60_000;
    return this.gcloud(
      input,
      stage,
      [
        "compute",
        "operations",
        "list",
        `--project=${input.project}`,
        `--filter=targetLink~/${name}$ AND status!=DONE`,
        "--format=json(name,status,targetLink)",
      ],
      signal,
      10_000,
    ).andThen((listed) => {
      const parsed = Result.fromThrowable(
        () => JSON.parse(listed.stdout) as unknown,
        (cause): ImageBuildError => ({
          type: "image_build_failed",
          stage,
          message: `invalid operation list: ${String(cause)}`,
        }),
      )();
      if (parsed.isErr()) return errAsync<void, ImageBuildError>(parsed.error);
      if (!Array.isArray(parsed.value)) {
        return errAsync<void, ImageBuildError>({
          type: "image_build_failed",
          stage,
          message: "invalid operation list shape",
        });
      }
      const names: string[] = [];
      for (const entry of parsed.value) {
        if (typeof entry !== "object" || entry === null) continue;
        const operation = entry as Record<string, unknown>;
        const targetLink = String(operation["targetLink"] ?? "").replace(
          /^https:\/\/www\.googleapis\.com\/compute\/v1\//,
          "",
        );
        if (targetLink !== target || operation["status"] === "DONE") continue;
        if (typeof operation["name"] !== "string" || operation["name"] === "") {
          return errAsync<void, ImageBuildError>({
            type: "image_build_failed",
            stage,
            message: `invalid operation for ${kind} ${name}`,
          });
        }
        names.push(operation["name"]);
      }
      return names.reduce<ResultAsync<void, ImageBuildError>>(
        (waiting, operation) =>
          waiting.andThen(() =>
            this.waitForTargetOperation(input, kind, operation, signal, deadline),
          ),
        okAsync<void, ImageBuildError>(undefined),
      );
    });
  }

  private waitForTargetOperation(
    input: ImageBuildInput,
    kind: "instances" | "disks" | "images",
    operation: string,
    signal: AbortSignal,
    deadline: number,
  ): ResultAsync<void, ImageBuildError> {
    const stage = "cleanup" as const;
    const remaining = deadline - this.cleanupTiming.now();
    if (remaining <= 0) {
      return errAsync<void, ImageBuildError>({
        type: "image_build_failed",
        stage,
        message: `timed out waiting for cleanup operation ${operation}`,
      });
    }
    return this.gcloud(
      input,
      stage,
      [
        "compute",
        "operations",
        "describe",
        operation,
        `--project=${input.project}`,
        ...(kind === "images" ? ["--global"] : [`--zone=${input.zone}`]),
        "--format=value(status)",
      ],
      signal,
      Math.min(10_000, remaining),
    ).andThen((described) => {
      const status = described.stdout.trim();
      if (status === "DONE") return okAsync<void, ImageBuildError>(undefined);
      if (status !== "PENDING" && status !== "RUNNING") {
        return errAsync<void, ImageBuildError>({
          type: "image_build_failed",
          stage,
          message: `invalid cleanup operation status ${status || "missing"}`,
        });
      }
      const waitRemaining = deadline - this.cleanupTiming.now();
      if (waitRemaining <= 0) {
        return errAsync<void, ImageBuildError>({
          type: "image_build_failed",
          stage,
          message: `timed out waiting for cleanup operation ${operation}`,
        });
      }
      return ResultAsync.fromPromise(
        this.cleanupTiming.wait(Math.min(5_000, waitRemaining), signal),
        (cause): ImageBuildError => ({
          type: signal.aborted ? "cancelled" : "image_build_failed",
          stage,
          message: String(cause),
        }),
      ).andThen(() => this.waitForTargetOperation(input, kind, operation, signal, deadline));
    });
  }

  capture(
    input: ImageBuildInput,
    kind: "runtime" | "workspace",
    signal: AbortSignal,
  ): ResultAsync<CapturedImage, ImageBuildError> {
    const name = this.name(input, kind === "runtime" ? "image" : "workspace-image");
    const source = this.name(input, kind === "runtime" ? "builder" : "workspace-disk");
    return this.gcloud(
      input,
      "capture",
      [
        "compute",
        "images",
        "create",
        name,
        `--project=${input.project}`,
        `--source-disk=${source}`,
        `--source-disk-zone=${input.zone}`,
        `--labels=${this.labels(input)}`,
        "--format=json",
      ],
      signal,
    ).andThen((result) =>
      Result.fromThrowable(
        () => JSON.parse(result.stdout) as unknown,
        (cause): ImageBuildError => ({
          type: "image_build_failed",
          stage: "capture",
          message: `invalid image response: ${String(cause)}`,
        }),
      )().andThen((value) => {
        const image = Array.isArray(value) && value.length === 1 ? value[0] : undefined;
        if (
          typeof image !== "object" ||
          image === null ||
          typeof image.id !== "string" ||
          !/^[0-9]+$/.test(image.id) ||
          typeof image.name !== "string" ||
          typeof image.selfLink !== "string" ||
          !image.selfLink.startsWith("https://www.googleapis.com/compute/v1/projects/")
        ) {
          return err<CapturedImage, ImageBuildError>({
            type: "image_build_failed",
            stage: "capture",
            message: "invalid image response shape",
          });
        }
        return ok<CapturedImage, ImageBuildError>({
          id: image.id,
          resource: image.selfLink.replace(/^https:\/\/www.googleapis.com\/compute\/v1\//, ""),
          name: image.name,
        });
      }),
    );
  }

  resolveBaseImageId(
    input: ImageBuildInput,
    signal: AbortSignal,
  ): ResultAsync<string, ImageBuildError> {
    return this.gcloud(
      input,
      "prerequisites",
      [...this.baseImageDescribeArgs(input), "--format=value(id)"],
      signal,
    ).map((result) => result.stdout.trim());
  }

  verifyBuilderBaseImage(
    input: ImageBuildInput,
    expectedBaseImageId: string,
    signal: AbortSignal,
  ): ResultAsync<void, ImageBuildError> {
    return this.gcloud(
      input,
      "builder",
      [
        "compute",
        "disks",
        "describe",
        this.name(input, "builder"),
        `--project=${input.project}`,
        `--zone=${input.zone}`,
        "--format=value(sourceImageId)",
      ],
      signal,
    ).andThen((result) =>
      result.stdout.trim() === expectedBaseImageId
        ? okAsync<void, ImageBuildError>(undefined)
        : errAsync<void, ImageBuildError>({
            type: "image_build_failed",
            stage: "builder",
            message: "builder base-image identity changed",
          }),
    );
  }

  verifyValidationWorkspaceImage(
    input: ImageBuildInput,
    expectedWorkspaceImageId: string,
    signal: AbortSignal,
  ): ResultAsync<void, ImageBuildError> {
    const data = this.name(input, "data");
    return this.gcloud(
      input,
      "validate",
      [
        "compute",
        "disks",
        "describe",
        data,
        `--project=${input.project}`,
        `--zone=${input.zone}`,
        "--format=value(sourceImageId)",
      ],
      signal,
    ).andThen((result) =>
      result.stdout.trim() === expectedWorkspaceImageId
        ? okAsync<void, ImageBuildError>(undefined)
        : errAsync<void, ImageBuildError>({
            type: "image_build_failed",
            stage: "validate",
            message: "validation workspace-image identity changed",
          }),
    );
  }

  readPackageInventory(
    input: ImageBuildInput,
    signal: AbortSignal,
  ): ResultAsync<string, ImageBuildError> {
    return this.ssh(
      input,
      "install",
      this.name(input, "builder"),
      "set -eu; sudo cat /var/log/pi-orb-image-build.log; for file in packages.tsv npm-tree.json node-version docker-version sizes-kib.tsv; do echo ===$file; sudo cat /opt/pi-orb/$file; done",
      signal,
    ).map((result) => result.stdout);
  }

  writeManifest(
    input: ImageBuildInput,
    manifest: ImageBuildManifest,
    signal: AbortSignal,
  ): ResultAsync<void, ImageBuildError> {
    return ResultAsync.fromPromise(
      mkdir(input.outputDir, { recursive: true }).then(() =>
        writeFile(`${input.outputDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, {
          mode: 0o600,
          signal,
        }),
      ),
      (cause) => ({
        type: signal.aborted ? "cancelled" : "image_build_failed",
        stage: "manifest",
        message: String(cause),
      }),
    );
  }

  writeFailure(
    input: ImageBuildInput,
    failure: ImageBuildError,
  ): ResultAsync<void, ImageBuildError> {
    return ResultAsync.fromPromise(
      mkdir(input.outputDir, { recursive: true }).then(() =>
        writeFile(
          `${input.outputDir}/failure.json`,
          `${JSON.stringify({ ...failure, operationId: input.operationId, at: this.now() }, null, 2)}\n`,
          { mode: 0o600 },
        ),
      ),
      (cause) => ({ type: "image_build_failed", stage: "manifest", message: String(cause) }),
    );
  }
}
