import {
  PROJECT_SECRET_MAX_BUNDLE_BYTES,
  PROJECT_SECRET_MAX_NAMES,
  PROJECT_SECRET_MAX_VALUE_BYTES,
  PROJECT_SECRET_NAME_PATTERN,
  type ProjectSecretList,
  type ProjectSecretSnapshot,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { ProjectConflict, ProjectSecretError, StoreError } from "./errors.ts";
import type {
  ProjectSecretPointerRow,
  ProjectSecretsDeps,
  StoredProjectSecretBundle,
} from "./ports.ts";

export const PROJECT_SECRETS_PROVIDER = "project-secrets";
const MAX_ATTEMPTS = 12;
const POINTER_CHANGED = "project secret pointer changed during mutation";
const NAME = new RegExp(PROJECT_SECRET_NAME_PATTERN);
const RESERVED = new Set([
  "HOME",
  "PATH",
  "PI_ORB_RUNTIME_TOKEN",
  "PI_ORB_CONTROL_PLANE_URL",
  "PI_ORB_TAILSCALE_AUTH_KEY",
  "PI_ORB_TAILSCALE_HOSTNAME",
  "PI_ORB_PREVIEW_HOST",
]);
const allowedName = (name: string): boolean =>
  NAME.test(name) && name.length <= 128 && !name.startsWith("PI_ORB_") && !RESERVED.has(name);

const retryable = (message: string): ProjectSecretError => ({
  type: "project_secret_retryable",
  message,
});
const corruption = (message: string): ProjectSecretError => ({
  type: "project_secret_corruption",
  message,
});
const conflict = (message: string): ProjectSecretError => ({
  type: "project_secret_conflict",
  message,
});

function fromStore(error: StoreError): ProjectSecretError {
  return error.code === "corruption" || error.code === "invariant"
    ? corruption("project secret storage is inconsistent")
    : retryable("project secrets are temporarily unavailable");
}

function fromProjectConflict(error: ProjectConflict): ProjectSecretError {
  return error.reason === "not_found"
    ? { type: "project_secret_not_found", message: "project not found" }
    : conflict("project is being permanently deleted");
}

function fromPointerReadError(error: StoreError | ProjectConflict): ProjectSecretError {
  return error.type === "project_conflict" ? fromProjectConflict(error) : fromStore(error);
}

function validBundle(value: unknown): value is StoredProjectSecretBundle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredProjectSecretBundle>;
  if (
    typeof candidate.projectId !== "string" ||
    !Number.isInteger(candidate.revision) ||
    candidate.revision === undefined ||
    candidate.revision < 1 ||
    typeof candidate.values !== "object" ||
    candidate.values === null ||
    Array.isArray(candidate.values)
  ) {
    return false;
  }
  return Object.entries(candidate.values).every(
    ([name, secret]) => allowedName(name) && typeof secret === "string",
  );
}

function metadata(pointer: ProjectSecretPointerRow | null): ProjectSecretList {
  if (pointer === null) return { revision: 0, items: [] };
  return {
    revision: pointer.revision,
    items: Object.entries(pointer.entries)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, updatedAt]) => ({ name, updatedAt: new Date(updatedAt).toISOString() })),
  };
}

export async function listProjectSecrets(
  task: SimulationTask,
  deps: ProjectSecretsDeps,
  projectId: string,
): Promise<Result<ProjectSecretList, ProjectSecretError>> {
  const pointer = await deps.pointers.readProjectSecretPointer(task, projectId);
  return pointer.isErr() ? err(fromPointerReadError(pointer.error)) : ok(metadata(pointer.value));
}

/** Stable pointer/version/pointer read: one complete old or new revision, never a mixture. */
export async function getProjectSecretSnapshot(
  task: SimulationTask,
  deps: ProjectSecretsDeps,
  projectId: string,
): Promise<Result<ProjectSecretSnapshot, ProjectSecretError>> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const before = await deps.pointers.readProjectSecretPointer(task, projectId);
    if (before.isErr()) return err(fromPointerReadError(before.error));
    if (before.value === null) return ok({ revision: 0, values: {} });
    const payload = await deps.secrets.readSecret<StoredProjectSecretBundle>(
      task,
      PROJECT_SECRETS_PROVIDER,
      before.value.secretVersion,
    );
    if (payload.isErr()) return err(fromStore(payload.error));
    const after = await deps.pointers.readProjectSecretPointer(task, projectId);
    if (after.isErr()) return err(fromPointerReadError(after.error));
    if (after.value?.rowVersion !== before.value.rowVersion) continue;
    if (payload.value === null) return err(corruption("project secret bundle is missing"));
    if (
      !validBundle(payload.value) ||
      payload.value.projectId !== projectId ||
      payload.value.revision !== before.value.revision
    ) {
      return err(corruption("project secret bundle identity does not match its pointer"));
    }
    return ok({ revision: payload.value.revision, values: { ...payload.value.values } });
  }
  return err(retryable("project secrets changed too frequently to read a stable snapshot"));
}

function validateInput(name: string, value: string): ProjectSecretError | null {
  if (!NAME.test(name) || name.length > 128) {
    return { type: "project_secret_invalid", message: "invalid environment variable name" };
  }
  if (!allowedName(name)) {
    return { type: "project_secret_invalid", message: `${name} is reserved by pi-orb` };
  }
  if (value.length === 0) {
    return { type: "project_secret_invalid", message: "secret value must not be empty" };
  }
  if (new TextEncoder().encode(value).byteLength > PROJECT_SECRET_MAX_VALUE_BYTES) {
    return { type: "project_secret_invalid", message: "secret value is too large" };
  }
  return null;
}

async function readBundleForMutation(
  task: SimulationTask,
  deps: ProjectSecretsDeps,
  projectId: string,
  pointer: ProjectSecretPointerRow | null,
): Promise<Result<StoredProjectSecretBundle, ProjectSecretError>> {
  if (pointer === null) return ok({ projectId, revision: 0, values: {} });
  const read = await deps.secrets.readSecret<StoredProjectSecretBundle>(
    task,
    PROJECT_SECRETS_PROVIDER,
    pointer.secretVersion,
  );
  if (read.isErr()) return err(fromStore(read.error));
  if (read.value === null) {
    // Deletion may have fenced the project and destroyed this version after
    // the writer read its pointer. Re-read through the active-project gate so
    // that race is a conflict, not false corruption.
    const current = await deps.pointers.readProjectSecretPointer(task, projectId);
    if (current.isErr()) return err(fromPointerReadError(current.error));
    if (current.value?.rowVersion !== pointer.rowVersion) {
      return err(retryable(POINTER_CHANGED));
    }
    return err(corruption("project secret bundle is missing"));
  }
  if (
    !validBundle(read.value) ||
    read.value.projectId !== projectId ||
    read.value.revision !== pointer.revision
  ) {
    return err(corruption("project secret bundle identity does not match its pointer"));
  }
  return ok(read.value);
}

async function mutateProjectSecret(
  task: SimulationTask,
  deps: ProjectSecretsDeps,
  projectId: string,
  name: string,
  value: string | null,
): Promise<Result<ProjectSecretList, ProjectSecretError>> {
  if (value !== null) {
    const invalid = validateInput(name, value);
    if (invalid !== null) return err(invalid);
  } else if (!allowedName(name)) {
    return err({ type: "project_secret_invalid", message: "invalid environment variable name" });
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await deps.pointers.readProjectSecretPointer(task, projectId);
    if (current.isErr()) return err(fromPointerReadError(current.error));
    const bundle = await readBundleForMutation(task, deps, projectId, current.value);
    if (bundle.isErr()) {
      if (
        bundle.error.type === "project_secret_retryable" &&
        bundle.error.message === POINTER_CHANGED
      ) {
        continue;
      }
      return err(bundle.error);
    }
    if (value === null && !(name in bundle.value.values)) return ok(metadata(current.value));

    const values = { ...bundle.value.values };
    if (value === null) delete values[name];
    else values[name] = value;
    if (Object.keys(values).length > PROJECT_SECRET_MAX_NAMES) {
      return err({ type: "project_secret_invalid", message: "project has too many secrets" });
    }
    const revision = bundle.value.revision + 1;
    const nextBundle: StoredProjectSecretBundle = { projectId, revision, values };
    if (
      new TextEncoder().encode(JSON.stringify(nextBundle)).byteLength >
      PROJECT_SECRET_MAX_BUNDLE_BYTES
    ) {
      return err({ type: "project_secret_invalid", message: "project secret bundle is too large" });
    }
    const written = await deps.secrets.writeSecret(task, PROJECT_SECRETS_PROVIDER, nextBundle);
    if (written.isErr()) return err(fromStore(written.error));
    const now = task.wallNow();
    const entries = { ...(current.value?.entries ?? {}) };
    if (value === null) delete entries[name];
    else entries[name] = now;
    const committed = await deps.pointers.casWriteProjectSecretPointer(
      task,
      projectId,
      current.value?.rowVersion ?? null,
      { revision, entries, secretVersion: written.value.version, updatedAt: now },
    );
    if (committed.isOk()) {
      if (current.value !== null) {
        await deps.secrets.destroySecret(
          task,
          PROJECT_SECRETS_PROVIDER,
          current.value.secretVersion,
        );
      }
      return ok(metadata(committed.value));
    }
    if (committed.error.type === "project_conflict") {
      await deps.secrets.destroySecret(task, PROJECT_SECRETS_PROVIDER, written.value.version);
      return err(fromProjectConflict(committed.error));
    }
    if (committed.error.type === "project_secret_pointer_conflict") {
      await deps.secrets.destroySecret(task, PROJECT_SECRETS_PROVIDER, written.value.version);
      continue;
    }
    // The CAS may have committed before its adapter reported failure. Read back
    // by exact version before deciding whether this version is orphaned.
    const observed = await deps.pointers.readProjectSecretPointer(task, projectId);
    if (observed.isOk() && observed.value?.secretVersion === written.value.version) {
      return ok(metadata(observed.value));
    }
    return err(fromStore(committed.error));
  }
  return err(retryable("project secret update conflicted too many times"));
}

export function putProjectSecret(
  task: SimulationTask,
  deps: ProjectSecretsDeps,
  projectId: string,
  name: string,
  value: string,
): ResultAsync<ProjectSecretList, ProjectSecretError> {
  return new ResultAsync(mutateProjectSecret(task, deps, projectId, name, value));
}

export function deleteProjectSecret(
  task: SimulationTask,
  deps: ProjectSecretsDeps,
  projectId: string,
  name: string,
): ResultAsync<ProjectSecretList, ProjectSecretError> {
  return new ResultAsync(mutateProjectSecret(task, deps, projectId, name, null));
}

/** Project-deletion cleanup after the active-project fence has landed. */
export function deleteAllProjectSecrets(
  task: SimulationTask,
  deps: ProjectSecretsDeps,
  projectId: string,
): ResultAsync<void, ProjectSecretError> {
  const run = async (): Promise<Result<void, ProjectSecretError>> => {
    const listed = await deps.secrets.listSecretVersions(task, PROJECT_SECRETS_PROVIDER);
    if (listed.isErr()) return err(fromStore(listed.error));
    for (const version of listed.value) {
      const payload = await deps.secrets.readSecret<StoredProjectSecretBundle>(
        task,
        PROJECT_SECRETS_PROVIDER,
        version,
      );
      if (payload.isErr()) return err(fromStore(payload.error));
      if (payload.value === null) continue;
      if (!validBundle(payload.value)) {
        return err(corruption("project secret namespace contains a malformed bundle"));
      }
      if (payload.value.projectId !== projectId) continue;
      const destroyed = await deps.secrets.destroySecret(task, PROJECT_SECRETS_PROVIDER, version);
      if (destroyed.isErr()) return err(fromStore(destroyed.error));
    }
    const removed = await deps.pointers.deleteProjectSecretPointer(task, projectId);
    if (removed.isErr()) {
      return err(
        removed.error.type === "project_conflict"
          ? fromProjectConflict(removed.error)
          : fromStore(removed.error),
      );
    }
    return ok(undefined);
  };
  return new ResultAsync(run());
}
