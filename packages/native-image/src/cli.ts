#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GcloudImageBuildEffects } from "./gcloud.ts";
import { buildNativeImage, type ImageBuildInput, validateImageBuildInput } from "./orchestrator.ts";
import { installAbortSignalHandlers } from "./signals.ts";
import { prepareSourceSnapshot } from "./snapshot.ts";

const execFileAsync = promisify(execFile);

function parseArgs(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      process.stderr.write(
        "usage: npm run native-image:build -- --project ID --zone ZONE --base-image RESOURCE --version VERSION --subnet RESOURCE --builder-service-account EMAIL --validation-service-account EMAIL --validation-repository-url URL [--output-dir PATH]\n",
      );
      process.exitCode = 2;
      return values;
    }
    values.set(key.slice(2), value);
  }
  return values;
}

async function main(): Promise<void> {
  process.chdir(fileURLToPath(new URL("../../..", import.meta.url)));
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "npm run native-image:build -- --project ID --zone ZONE --base-image RESOURCE --version VERSION --subnet RESOURCE --builder-service-account EMAIL --validation-service-account EMAIL --validation-repository-url URL [--output-dir PATH]\n",
    );
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (process.exitCode !== undefined) return;
  const controller = new AbortController();
  installAbortSignalHandlers(controller);
  const sourceCommit = (await execFileAsync("git", ["rev-parse", "HEAD"])).stdout.trim();
  const sourceDirty =
    (
      await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"])
    ).stdout.trim() !== "";
  const operationId = randomUUID().replaceAll("-", "").slice(0, 16);
  const outputDir =
    args.get("output-dir") ??
    `.context/native-image/${args.get("version") ?? "invalid"}-${operationId}`;
  process.stderr.write(`evidence: ${outputDir}\n`);
  let input: ImageBuildInput = {
    project: args.get("project") ?? "",
    zone: args.get("zone") ?? "",
    baseImage: args.get("base-image") ?? "",
    version: args.get("version") ?? "",
    subnetwork: args.get("subnet") ?? "",
    builderServiceAccount: args.get("builder-service-account") ?? "",
    validationServiceAccount: args.get("validation-service-account") ?? "",
    sourceCommit,
    sourceDirty,
    sourceArchiveSha256: "",
    operationId,
    outputDir,
    validationRepositoryUrl: args.get("validation-repository-url") ?? "",
    inputInventory: {},
    toolingInputInventory: {},
  };
  const valid = validateImageBuildInput(input);
  if (valid.isErr()) {
    process.stderr.write(`${valid.error.message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write("snapshot: create started\n");
  const snapshot = await prepareSourceSnapshot(outputDir);
  if (snapshot.isErr()) {
    process.stderr.write(`${snapshot.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write("snapshot: create succeeded\n");
  input = {
    ...input,
    sourceArchiveSha256: snapshot.value.archiveSha256,
    inputInventory: snapshot.value.inputInventory,
    toolingInputInventory: snapshot.value.toolingInputInventory,
  };
  const result = await buildNativeImage(
    input,
    new GcloudImageBuildEffects(),
    controller.signal,
    ({ stage, action, status }) => process.stderr.write(`${stage}: ${action} ${status}\n`),
  );
  if (result.isErr()) {
    process.stderr.write(`${result.error.stage}: ${result.error.message}\nlogs: ${outputDir}\n`);
    process.exitCode = result.error.type === "cancelled" ? 130 : 1;
    return;
  }
  process.stdout.write(`${result.value.imageResource}\nmanifest: ${outputDir}/manifest.json\n`);
}

await main().catch((cause) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
