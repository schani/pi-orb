import { ORB_NAME_MAX_CHARS } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { withDeadline } from "./dst.ts";
import type { StoreError } from "./errors.ts";
import type {
  ControlPlaneStore,
  OrbNameGenerator as GeneratorPort,
  OrbNameGeneratorError,
} from "./ports.ts";

export type OrbNameGenerator = GeneratorPort;

export interface OrbNamingDeps {
  readonly store: ControlPlaneStore;
  readonly generator: OrbNameGenerator;
  readonly leaseMs: number;
}

export interface OrbNamingError {
  readonly type: "orb_naming_error";
  /** `invariant` is a deterministic store bug (`StoreError` code `invariant`): never retryable. */
  readonly code: "not_found" | "conflict" | "invalid_name" | "store" | "invariant" | "generation";
  readonly message: string;
  readonly retryable: boolean;
}

export type OrbNamingOutcome = "assigned" | "already_named" | "in_progress" | "backoff";

export function normalizeOrbName(value: string): Result<string, OrbNamingError> {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized === "" || Array.from(normalized).length > ORB_NAME_MAX_CHARS) {
    return err({
      type: "orb_naming_error",
      code: "invalid_name",
      message: `orb name must contain 1-${ORB_NAME_MAX_CHARS} characters`,
      retryable: false,
    });
  }
  return ok(normalized);
}

const storeError = (error: StoreError): OrbNamingError => ({
  type: "orb_naming_error",
  code: error.code === "invariant" ? "invariant" : "store",
  message: error.message,
  retryable: error.retryable,
});

export function setOrbName(
  task: SimulationTask,
  store: ControlPlaneStore,
  orbId: string,
  value: string,
  now: number,
): ResultAsync<import("./orb.ts").OrbRow, OrbNamingError> {
  const name = normalizeOrbName(value);
  if (name.isErr())
    return ResultAsync.fromSafePromise(Promise.resolve()).andThen(() => err(name.error));
  const run = async (): Promise<Result<import("./orb.ts").OrbRow, OrbNamingError>> => {
    const current = await store.getOrb(task, orbId);
    if (current.isErr()) return err(storeError(current.error));
    if (current.value === null) {
      return err({
        type: "orb_naming_error",
        code: "not_found",
        message: "orb not found",
        retryable: false,
      });
    }
    if (
      current.value.state === "deleting" ||
      current.value.state === "archiving" ||
      current.value.state === "archived"
    ) {
      return err({
        type: "orb_naming_error",
        code: "conflict",
        message: "orb is being permanently deleted",
        retryable: false,
      });
    }
    return store
      .setOrbName(task, { orbId, name: name.value, now, onlyIfNull: false })
      .mapErr(storeError)
      .andThen((orb) =>
        orb === null
          ? err({
              type: "orb_naming_error" as const,
              code: "not_found" as const,
              message: "orb not found",
              retryable: false,
            })
          : ok(orb),
      );
  };
  return new ResultAsync(run());
}

function generationError(error: OrbNameGeneratorError): OrbNamingError {
  return {
    type: "orb_naming_error",
    code: "generation",
    message: error.message,
    retryable: error.retryable,
  };
}

export function generateOrbName(
  task: SimulationTask,
  deps: OrbNamingDeps,
  orbId: string,
  input: { message: string; readme: string | null },
): ResultAsync<OrbNamingOutcome, OrbNamingError> {
  const run = async (): Promise<Result<OrbNamingOutcome, OrbNamingError>> => {
    const orb = await deps.store.getOrb(task, orbId);
    if (orb.isErr()) return err(storeError(orb.error));
    if (orb.value === null) {
      return err({
        type: "orb_naming_error",
        code: "not_found",
        message: "orb not found",
        retryable: false,
      });
    }
    if (
      orb.value.state === "deleting" ||
      orb.value.state === "archiving" ||
      orb.value.state === "archived"
    ) {
      return err({
        type: "orb_naming_error",
        code: "conflict",
        message: "orb is being permanently deleted",
        retryable: false,
      });
    }
    if (orb.value.name !== null) return ok("already_named");
    const project = await deps.store.getProject(task, orb.value.projectId);
    if (project.isErr()) return err(storeError(project.error));
    if (project.value === null) {
      return err({
        type: "orb_naming_error",
        code: "not_found",
        message: "project not found",
        retryable: false,
      });
    }
    const projectRow = project.value;
    const now = task.wallNow();
    const claim = await deps.store.claimOrbAutoName(task, {
      orbId,
      now,
      leaseUntil: now + deps.leaseMs,
    });
    if (claim.isErr()) return err(storeError(claim.error));
    if (claim.value !== "claimed") return ok(claim.value);

    const generated = await withDeadline(
      task,
      Math.max(1, deps.leaseMs - 1_000),
      "Luna orb-name generation",
      (context) =>
        deps.generator.generate(
          task,
          {
            projectName: projectRow.name,
            repositoryUrl: projectRow.repositoryUrl,
            message: input.message,
            readme: input.readme,
          },
          context,
        ),
    );
    if (generated.isErr()) {
      const retry = Math.min(60 * 60_000, 5_000 * 2 ** Math.min(orb.value.autoNameAttempts, 8));
      const failed = await deps.store.failOrbAutoName(task, {
        orbId,
        now: task.wallNow(),
        nextAttemptAt: task.wallNow() + retry,
      });
      if (failed.isErr()) return err(storeError(failed.error));
      return err(generationError(generated.error));
    }
    const name = normalizeOrbName(generated.value.replace(/^["'`]+|["'`]+$/g, ""));
    if (name.isErr()) {
      await deps.store.failOrbAutoName(task, {
        orbId,
        now: task.wallNow(),
        nextAttemptAt: task.wallNow() + 5_000,
      });
      return err({ ...name.error, code: "generation", retryable: true });
    }
    const assigned = await deps.store.setOrbName(task, {
      orbId,
      name: name.value,
      now: task.wallNow(),
      onlyIfNull: true,
    });
    if (assigned.isErr()) return err(storeError(assigned.error));
    return ok(assigned.value === null ? "already_named" : "assigned");
  };
  return new ResultAsync(run());
}
