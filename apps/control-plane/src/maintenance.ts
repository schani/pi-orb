import { fileURLToPath } from "node:url";
import { NoSimulationTask, type SimulationTask } from "determined";
import { err, ok, type Result } from "neverthrow";
import { createGcsTokenProvider } from "./adapters/hosting/gcs.ts";
import {
  createMaintenanceReceipts,
  type MaintenanceBinding,
  maintenanceCounts,
  safeMaintenanceId,
} from "./adapters/maintenance-receipts.ts";
import {
  drainMaintenance,
  inventoryMaintenance,
  type MaintenanceError,
  type MaintenanceReceipt,
  type MaintenanceSnapshot,
  resumeMaintenance,
  validateFinalMaintenance,
} from "./domain/maintenance.ts";
import {
  composeMaintenanceLifecycle,
  type MaintenanceComposition,
} from "./lifecycle-composition.ts";

interface MaintenanceInput extends MaintenanceBinding {
  bucket: string;
  timeoutMs: number;
  baseline?: MaintenanceReceipt | undefined;
}
const invalid = (): MaintenanceError => ({ type: "maintenance_error", code: "invalid" });
export function readMaintenanceInput(
  args: string[],
  environment: Record<string, string | undefined>,
): Result<MaintenanceInput, MaintenanceError> {
  const mode = args[0];
  if (mode !== "inventory" && mode !== "drain" && mode !== "resume") return err(invalid());
  const flags = new Map<string, string>();
  const allowed = [
    "--release-id",
    "--phase",
    "--snapshot-uri",
    "--snapshot-generation",
    "--snapshot-sha256",
  ];
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key || !value || !allowed.includes(key) || flags.has(key)) return err(invalid());
    flags.set(key, value);
  }
  const releaseId = flags.get("--release-id") ?? "";
  const phase = flags.get("--phase");
  const executionId = environment["PI_ORB_MAINTENANCE_EXECUTION_ID"] ?? "";
  const sourceSha = environment["PI_ORB_MAINTENANCE_SOURCE_SHA"] ?? "";
  const bucket = environment["PI_ORB_HOSTING_BUCKET"] ?? "";
  const timeoutMs = Number(environment["PI_ORB_MAINTENANCE_TIMEOUT_MS"] ?? "900000");
  if (
    !safeMaintenanceId(releaseId) ||
    !safeMaintenanceId(executionId) ||
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    !/^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$/.test(bucket) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 900000 ||
    !environment["DATABASE_URL"]
  )
    return err(invalid());
  if (
    (mode === "inventory" && phase !== "before" && phase !== "final") ||
    (mode === "drain" && phase !== "drain") ||
    (mode === "resume" && phase !== "preapply-resume")
  )
    return err(invalid());
  const needsBaseline = phase === "final" || mode === "resume";
  let baseline: MaintenanceReceipt | undefined;
  if (needsBaseline) {
    const receiptUri = flags.get("--snapshot-uri") ?? "";
    const generation = flags.get("--snapshot-generation") ?? "";
    const sha256 = flags.get("--snapshot-sha256") ?? "";
    const previousPhase = mode === "resume" ? "final" : "drain";
    if (
      !receiptUri.startsWith(`gs://${bucket}/release-maintenance/${releaseId}/${previousPhase}/`) ||
      !/^[1-9][0-9]*$/.test(generation) ||
      !/^[a-f0-9]{64}$/.test(sha256)
    )
      return err(invalid());
    baseline = { receiptUri, generation, sha256 };
  } else if (flags.size !== 2) return err(invalid());
  if (
    mode === "resume" &&
    (environment["PI_ORB_MAINTENANCE_LEGACY_WRITERS_RETIRED"] !== "1" ||
      environment["PI_ORB_MAINTENANCE_CANDIDATE_EXPOSED"] !== "0")
  )
    return err(invalid());
  return ok({
    mode,
    phase: phase as MaintenanceBinding["phase"],
    releaseId,
    executionId,
    sourceSha,
    bucket,
    timeoutMs,
    baseline,
  });
}

export async function runMaintenance(
  args: string[],
  environment: Record<string, string | undefined>,
  adapters: {
    compose?: typeof composeMaintenanceLifecycle;
    receipts?: (input: MaintenanceInput) => ReturnType<typeof createMaintenanceReceipts>;
    task?: SimulationTask;
    stdout?: (line: string) => void;
  } = {},
): Promise<Result<void, MaintenanceError>> {
  const input = readMaintenanceInput(args, environment);
  if (input.isErr()) return err(input.error);
  const config = input.value;
  const task = adapters.task ?? new NoSimulationTask("maintenance", false);
  const composed = await (adapters.compose ?? composeMaintenanceLifecycle)(environment);
  if (composed.isErr()) return err(composed.error);
  const composition: MaintenanceComposition = composed.value;
  let success: { receipt: MaintenanceReceipt; counts: Record<string, number> } | undefined;
  let failure: MaintenanceError | undefined;
  const execute = async (): Promise<Result<void, MaintenanceError>> => {
    const receipts =
      adapters.receipts?.(config) ??
      createMaintenanceReceipts({
        bucket: config.bucket,
        binding: config,
        auth: createGcsTokenProvider(),
      });
    const baseline = config.baseline
      ? await receipts.read(config.baseline, config.mode === "resume" ? "final" : "drain")
      : undefined;
    if (baseline?.isErr()) return err(baseline.error);
    let snapshot: MaintenanceSnapshot;
    let counts: Record<string, number>;
    if (config.mode === "drain") {
      const drained = await drainMaintenance(
        task,
        composition.deps,
        receipts,
        config.releaseId,
        config.timeoutMs,
      );
      if (drained.isErr()) return err(drained.error);
      snapshot = drained.value;
      counts = maintenanceCounts(snapshot);
    } else if (config.mode === "resume") {
      if (!baseline?.isOk()) return err(invalid());
      snapshot = baseline.value;
      counts = { ...maintenanceCounts(snapshot), resumed: 0, deferred: 0 };
      for (const candidate of snapshot.resumeCandidates) {
        const resumed = await resumeMaintenance(
          task,
          composition.deps,
          { ...snapshot, resumeCandidates: [candidate] },
          { phase: "preapply-resume", legacyIntentWritersRetired: true, candidateExposed: false },
        );
        if (resumed.isErr()) return err(resumed.error);
        await task.failpoint("maintenance.before-resume-receipt");
        const outcome = await inventoryMaintenance(
          task,
          composition.deps,
          config.releaseId,
          "preapply-resume",
        );
        if (outcome.isErr()) return err(outcome.error);
        const sealed = await receipts.seal(
          `resume-${candidate.orbId}-${candidate.stateVersion}`,
          outcome.value,
          resumed.value,
        );
        if (sealed.isErr()) return err(sealed.error);
        counts["resumed"] = (counts["resumed"] ?? 0) + resumed.value.resumed;
        counts["deferred"] = (counts["deferred"] ?? 0) + resumed.value.deferred;
      }
      const admitted = await inventoryMaintenance(
        task,
        composition.deps,
        config.releaseId,
        "preapply-resume",
      );
      if (admitted.isErr()) return err(admitted.error);
      snapshot = admitted.value;
    } else {
      const inventory = await inventoryMaintenance(
        task,
        composition.deps,
        config.releaseId,
        config.phase,
        baseline?.isOk() ? baseline.value : undefined,
      );
      if (inventory.isErr()) return err(inventory.error);
      snapshot = inventory.value;
      if (config.phase === "final") {
        const validated = await validateFinalMaintenance(task, composition.deps, snapshot);
        if (validated.isErr()) return err(validated.error);
      }
      counts = maintenanceCounts(snapshot);
    }
    await task.failpoint("maintenance.before-result-receipt");
    const sealed = await receipts.seal("result", snapshot, counts);
    if (sealed.isErr()) return err(sealed.error);
    await task.checkpoint("maintenance.result-sealed");
    success = { receipt: sealed.value, counts };
    return ok(undefined);
  };
  try {
    const result = await execute();
    if (result.isErr()) failure = result.error;
  } finally {
    const closed = await composition.close();
    if (closed.isErr()) failure = closed.error;
  }
  if (failure) return err(failure);
  if (!success) return err(invalid());
  (adapters.stdout ?? console.log)(
    JSON.stringify({
      mode: config.mode,
      phase: config.phase,
      releaseId: config.releaseId,
      executionId: config.executionId,
      ...success.receipt,
      counts: success.counts,
      outcome: "sealed",
    }),
  );
  return ok(undefined);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runMaintenance(process.argv.slice(2), process.env);
  if (result.isErr()) {
    console.error(JSON.stringify({ outcome: "failed", code: result.error.code }));
    process.exitCode = 1;
  }
}
