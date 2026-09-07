import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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

export class GcloudImageBuildEffects implements ImageBuildEffects {
  private commandNumber = 0;
  private readonly commandRunner: CommandRunner;

  constructor(commandRunner: CommandRunner = execFileAsync) {
    this.commandRunner = commandRunner;
  }

  now(): string {
    return new Date().toISOString();
  }

  private name(input: ImageBuildInput, kind: "builder" | "validator" | "data" | "image"): string {
    const suffix = input.operationId
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 16);
    const reserved = `pi-orb-${kind}--${suffix}`.length;
    const version = input.version.slice(0, 63 - reserved).replace(/-$/, "");
    return `pi-orb-${kind}-${version}-${suffix}`;
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
            timeout: 300_000,
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
  ): ResultAsync<RunResult, ImageBuildError> {
    return this.execute(input, stage, "gcloud", args, signal);
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
        instance,
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
    const common = [`--project=${input.project}`, `--zone=${input.zone}`];
    switch (`${stage}:${action}`) {
      case "prerequisites:check":
        return this.execute(input, stage, "tar", ["--version"], signal)
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
          )
          .andThen(() =>
            this.gcloud(input, stage, this.baseImageDescribeArgs(input), signal).map(
              () => undefined,
            ),
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
            `${builder}:source.tar.gz`,
            ...common,
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
            "--size=20GB",
            "--type=pd-balanced",
            `--labels=${this.labels(input)}`,
            "--format=json",
          ],
          signal,
        )
          .andThen(() =>
            ResultAsync.fromPromise(
              writeFile(
                `${input.outputDir}/validation-config.json`,
                `${JSON.stringify({ PI_ORB_ID: `image-validation-${input.operationId}`, PI_ORB_RUNTIME_TOKEN: runtimeToken, PI_ORB_CONTROL_PLANE_URL: "http://127.0.0.1:18080", PI_ORB_HOST_INCARNATION: "0", PI_ORB_REPOSITORY_URL: input.validationRepositoryUrl })}\n`,
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
      case "cleanup:delete-data":
        return this.deleteOwned(input, "disks", data, signal);
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
    return this.gcloud(
      input,
      stage,
      ["compute", kind, "describe", name, ...scope, "--format=value(labels.pi-orb-native-build)"],
      signal,
    )
      .orElse((failure) =>
        failure.message.includes("not found") || failure.message.includes("was not found")
          ? okAsync({ stdout: "", stderr: "" })
          : errAsync(failure),
      )
      .andThen((description) => {
        const owner = description.stdout.trim();
        if (owner === "") return okAsync<void, ImageBuildError>(undefined);
        if (owner !== input.operationId)
          return errAsync<void, ImageBuildError>({
            type: "image_build_failed",
            stage,
            message: `refusing to delete foreign ${kind} ${name}`,
          });
        return this.gcloud(
          input,
          stage,
          ["compute", kind, "delete", name, ...scope, "--quiet"],
          signal,
        ).map(() => undefined);
      });
  }

  capture(
    input: ImageBuildInput,
    signal: AbortSignal,
  ): ResultAsync<CapturedImage, ImageBuildError> {
    const name = this.name(input, "image");
    const builder = this.name(input, "builder");
    return this.gcloud(
      input,
      "capture",
      [
        "compute",
        "images",
        "create",
        name,
        `--project=${input.project}`,
        `--source-disk=${builder}`,
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
