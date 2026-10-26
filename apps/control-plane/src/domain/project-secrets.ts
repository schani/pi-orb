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
  CredentialSecretStore,
  OwnerSecretsDeps,
  ProjectSecretPointerRow,
  ProjectSecretPointerWrite,
  ProjectSecretsDeps,
  StoredProjectSecretBundle,
  StoredUserSecretBundle,
} from "./ports.ts";

export const PROJECT_SECRETS_PROVIDER = "project-secrets";
export const OWNER_SECRETS_PROVIDER = "user-secrets";
const MAX_ATTEMPTS = 12;
const POINTER_CHANGED = "secret pointer changed during mutation";
const NAME = new RegExp(PROJECT_SECRET_NAME_PATTERN);
const RESERVED = new Set([
  "__proto__",
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

type Label = "project" | "owner";
type SecretBundle = StoredProjectSecretBundle | StoredUserSecretBundle;
type SecretPointer = Omit<ProjectSecretPointerRow, "projectId">;

/** How a scope's pointer CAS failed; `refused` is final, `unknown` may have committed. */
type CasFailure =
  | { readonly type: "pointer_conflict" }
  | { readonly type: "refused"; readonly error: ProjectSecretError }
  | { readonly type: "unknown"; readonly error: StoreError };

/**
 * One bundle owner: a project or a user (docs/owner-skills-secrets.md). The
 * stable read, CAS mutation, caps and orphan handling below are shared; a scope
 * only supplies its pointer store, provider namespace and bundle identity.
 */
interface SecretScope {
  readonly label: Label;
  readonly provider: string;
  readonly key: "projectId" | "userId";
  readonly id: string;
  readonly secrets: CredentialSecretStore;
  read(task: SimulationTask): ResultAsync<SecretPointer | null, ProjectSecretError>;
  cas(
    task: SimulationTask,
    expectedRowVersion: number | null,
    next: ProjectSecretPointerWrite,
  ): ResultAsync<SecretPointer, CasFailure>;
}

function fromStore(error: StoreError, label: Label = "project"): ProjectSecretError {
  return error.code === "corruption" || error.code === "invariant"
    ? corruption(`${label} secret storage is inconsistent`)
    : retryable(`${label} secrets are temporarily unavailable`);
}

function fromProjectConflict(error: ProjectConflict): ProjectSecretError {
  return error.reason === "not_found"
    ? { type: "project_secret_not_found", message: "project not found" }
    : conflict("project is being permanently deleted");
}

function fromPointerReadError(error: StoreError | ProjectConflict): ProjectSecretError {
  return error.type === "project_conflict" ? fromProjectConflict(error) : fromStore(error);
}

function projectScope(deps: ProjectSecretsDeps, projectId: string): SecretScope {
  return {
    label: "project",
    provider: PROJECT_SECRETS_PROVIDER,
    key: "projectId",
    id: projectId,
    secrets: deps.secrets,
    read: (task) =>
      deps.pointers.readProjectSecretPointer(task, projectId).mapErr(fromPointerReadError),
    cas: (task, expectedRowVersion, next) =>
      deps.pointers
        .casWriteProjectSecretPointer(task, projectId, expectedRowVersion, next)
        .mapErr((error): CasFailure => {
          switch (error.type) {
            case "project_secret_pointer_conflict":
              return { type: "pointer_conflict" };
            case "project_conflict":
              return { type: "refused", error: fromProjectConflict(error) };
            case "project_secret_in_use":
              return {
                type: "refused",
                error: conflict(
                  `Cannot delete ${error.secrets.join(", ")}: used by MCP ${error.servers.join(", ")}`,
                ),
              };
            case "store_error":
              return { type: "unknown", error };
          }
        }),
  };
}

const userNotFound: ProjectSecretError = {
  type: "project_secret_not_found",
  message: "user not found",
};

/** Users are never deleted, so owner secrets have no deletion fence or MCP references. */
function ownerScope(deps: OwnerSecretsDeps, userId: string): SecretScope {
  return {
    label: "owner",
    provider: OWNER_SECRETS_PROVIDER,
    key: "userId",
    id: userId,
    secrets: deps.secrets,
    read: (task) =>
      deps.pointers
        .readUserSecretPointer(task, userId)
        .mapErr((error) =>
          error.type === "user_not_found" ? userNotFound : fromStore(error, "owner"),
        ),
    cas: (task, expectedRowVersion, next) =>
      deps.pointers
        .casWriteUserSecretPointer(task, userId, expectedRowVersion, next)
        .mapErr((error): CasFailure => {
          switch (error.type) {
            case "project_secret_pointer_conflict":
              return { type: "pointer_conflict" };
            case "user_not_found":
              return { type: "refused", error: userNotFound };
            case "store_error":
              return { type: "unknown", error };
          }
        }),
  };
}

function bundleOf(
  scope: SecretScope,
  revision: number,
  values: Record<string, string>,
): SecretBundle {
  return scope.key === "projectId"
    ? { projectId: scope.id, revision, values }
    : { userId: scope.id, revision, values };
}

function validBundle(value: unknown, key: SecretScope["key"]): value is SecretBundle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredProjectSecretBundle & StoredUserSecretBundle>;
  if (
    typeof candidate[key] !== "string" ||
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

/** The bundle a pointer names: right shape, right owner, right revision. */
function matches(scope: SecretScope, value: unknown, pointer: SecretPointer): boolean {
  return (
    validBundle(value, scope.key) &&
    (value as Partial<Record<SecretScope["key"], string>>)[scope.key] === scope.id &&
    value.revision === pointer.revision
  );
}

function metadata(pointer: SecretPointer | null): ProjectSecretList {
  if (pointer === null) return { revision: 0, items: [] };
  return {
    revision: pointer.revision,
    items: Object.entries(pointer.entries)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, updatedAt]) => ({ name, updatedAt: new Date(updatedAt).toISOString() })),
  };
}

async function list(
  task: SimulationTask,
  scope: SecretScope,
): Promise<Result<ProjectSecretList, ProjectSecretError>> {
  const pointer = await scope.read(task);
  return pointer.isErr() ? err(pointer.error) : ok(metadata(pointer.value));
}

/** Stable pointer/version/pointer read: one complete old or new revision, never a mixture. */
async function snapshot(
  task: SimulationTask,
  scope: SecretScope,
): Promise<Result<ProjectSecretSnapshot, ProjectSecretError>> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const before = await scope.read(task);
    if (before.isErr()) return err(before.error);
    if (before.value === null) return ok({ revision: 0, values: {} });
    const payload = await scope.secrets.readSecret<SecretBundle>(
      task,
      scope.provider,
      before.value.secretVersion,
    );
    if (payload.isErr()) return err(fromStore(payload.error, scope.label));
    const after = await scope.read(task);
    if (after.isErr()) return err(after.error);
    if (after.value?.rowVersion !== before.value.rowVersion) continue;
    if (payload.value === null) return err(corruption(`${scope.label} secret bundle is missing`));
    if (!matches(scope, payload.value, before.value)) {
      return err(corruption(`${scope.label} secret bundle identity does not match its pointer`));
    }
    if (Object.values(payload.value.values).some((value) => value.includes("\0"))) {
      return err(corruption(`${scope.label} secret bundle contains an invalid value`));
    }
    return ok({ revision: payload.value.revision, values: { ...payload.value.values } });
  }
  return err(retryable(`${scope.label} secrets changed too frequently to read a stable snapshot`));
}

export function listProjectSecrets(
  task: SimulationTask,
  deps: ProjectSecretsDeps,
  projectId: string,
): Promise<Result<ProjectSecretList, ProjectSecretError>> {
  return list(task, projectScope(deps, projectId));
}

export function getProjectSecretSnapshot(
  task: SimulationTask,
  deps: ProjectSecretsDeps,
  projectId: string,
): Promise<Result<ProjectSecretSnapshot, ProjectSecretError>> {
  return snapshot(task, projectScope(deps, projectId));
}

export function listOwnerSecrets(
  task: SimulationTask,
  deps: OwnerSecretsDeps,
  userId: string,
): Promise<Result<ProjectSecretList, ProjectSecretError>> {
  return list(task, ownerScope(deps, userId));
}

export function getOwnerSecretSnapshot(
  task: SimulationTask,
  deps: OwnerSecretsDeps,
  userId: string,
): Promise<Result<ProjectSecretSnapshot, ProjectSecretError>> {
  return snapshot(task, ownerScope(deps, userId));
}

/**
 * What an orb receives: its project owner's secrets overlaid by its project's
 * (project wins per name). Each bundle is read stably on its own. The runtime
 * ignores `revision`; the sum of both monotonic revisions changes whenever
 * either bundle does.
 */
export async function getOrbSecretSnapshot(
  task: SimulationTask,
  deps: { readonly project: ProjectSecretsDeps; readonly owner: OwnerSecretsDeps },
  ids: { readonly projectId: string; readonly ownerUserId: string },
): Promise<Result<ProjectSecretSnapshot, ProjectSecretError>> {
  const owner = await getOwnerSecretSnapshot(task, deps.owner, ids.ownerUserId);
  if (owner.isErr()) return err(owner.error);
  const project = await getProjectSecretSnapshot(task, deps.project, ids.projectId);
  if (project.isErr()) return err(project.error);
  return ok({
    revision: owner.value.revision + project.value.revision,
    values: { ...owner.value.values, ...project.value.values },
  });
}

function validateInput(name: string, value: string): ProjectSecretError | null {
  if (!NAME.test(name) || name.length > 128) {
    return { type: "project_secret_invalid", message: "invalid environment variable name" };
  }
  if (!allowedName(name)) {
    return { type: "project_secret_invalid", message: `${name} is reserved by pi-orb` };
  }
  if (value.includes("\0")) {
    return { type: "project_secret_invalid", message: "secret value must not contain NUL" };
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
  scope: SecretScope,
  pointer: SecretPointer | null,
): Promise<Result<SecretBundle, ProjectSecretError>> {
  if (pointer === null) return ok(bundleOf(scope, 0, {}));
  const read = await scope.secrets.readSecret<SecretBundle>(
    task,
    scope.provider,
    pointer.secretVersion,
  );
  if (read.isErr()) return err(fromStore(read.error, scope.label));
  if (read.value === null) {
    // Deletion may have fenced the project and destroyed this version after
    // the writer read its pointer. Re-read through the active-project gate so
    // that race is a conflict, not false corruption.
    const current = await scope.read(task);
    if (current.isErr()) return err(current.error);
    if (current.value?.rowVersion !== pointer.rowVersion) {
      return err(retryable(POINTER_CHANGED));
    }
    return err(corruption(`${scope.label} secret bundle is missing`));
  }
  if (!matches(scope, read.value, pointer)) {
    return err(corruption(`${scope.label} secret bundle identity does not match its pointer`));
  }
  return ok(read.value);
}

async function mutate(
  task: SimulationTask,
  scope: SecretScope,
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
    const current = await scope.read(task);
    if (current.isErr()) return err(current.error);
    const bundle = await readBundleForMutation(task, scope, current.value);
    if (bundle.isErr()) {
      if (
        bundle.error.type === "project_secret_retryable" &&
        bundle.error.message === POINTER_CHANGED
      ) {
        continue;
      }
      return err(bundle.error);
    }
    if (value === null && !Object.hasOwn(bundle.value.values, name))
      return ok(metadata(current.value));

    const values = { ...bundle.value.values };
    if (value === null) delete values[name];
    else values[name] = value;
    if (Object.keys(values).length > PROJECT_SECRET_MAX_NAMES) {
      return err({
        type: "project_secret_invalid",
        message: `${scope.label} has too many secrets`,
      });
    }
    const revision = bundle.value.revision + 1;
    const nextBundle = bundleOf(scope, revision, values);
    if (
      new TextEncoder().encode(JSON.stringify(nextBundle)).byteLength >
      PROJECT_SECRET_MAX_BUNDLE_BYTES
    ) {
      return err({
        type: "project_secret_invalid",
        message: `${scope.label} secret bundle is too large`,
      });
    }
    const written = await scope.secrets.writeSecret(task, scope.provider, nextBundle);
    if (written.isErr()) return err(fromStore(written.error, scope.label));
    const now = task.wallNow();
    const entries = { ...(current.value?.entries ?? {}) };
    if (value === null) delete entries[name];
    else entries[name] = now;
    const committed = await scope.cas(task, current.value?.rowVersion ?? null, {
      revision,
      entries,
      secretVersion: written.value.version,
      updatedAt: now,
    });
    if (committed.isOk()) {
      if (current.value !== null) {
        await scope.secrets.destroySecret(task, scope.provider, current.value.secretVersion);
      }
      return ok(metadata(committed.value));
    }
    if (committed.error.type === "refused") {
      await scope.secrets.destroySecret(task, scope.provider, written.value.version);
      return err(committed.error.error);
    }
    if (committed.error.type === "pointer_conflict") {
      await scope.secrets.destroySecret(task, scope.provider, written.value.version);
      continue;
    }
    // The CAS may have committed before its adapter reported failure. Read back
    // by exact version before deciding whether this version is orphaned.
    const observed = await scope.read(task);
    if (observed.isOk() && observed.value?.secretVersion === written.value.version) {
      return ok(metadata(observed.value));
    }
    return err(fromStore(committed.error.error, scope.label));
  }
  return err(retryable(`${scope.label} secret update conflicted too many times`));
}

export function putProjectSecret(
  task: SimulationTask,
  deps: ProjectSecretsDeps,
  projectId: string,
  name: string,
  value: string,
): ResultAsync<ProjectSecretList, ProjectSecretError> {
  return new ResultAsync(mutate(task, projectScope(deps, projectId), name, value));
}

export function deleteProjectSecret(
  task: SimulationTask,
  deps: ProjectSecretsDeps,
  projectId: string,
  name: string,
): ResultAsync<ProjectSecretList, ProjectSecretError> {
  return new ResultAsync(mutate(task, projectScope(deps, projectId), name, null));
}

export function putOwnerSecret(
  task: SimulationTask,
  deps: OwnerSecretsDeps,
  userId: string,
  name: string,
  value: string,
): ResultAsync<ProjectSecretList, ProjectSecretError> {
  return new ResultAsync(mutate(task, ownerScope(deps, userId), name, value));
}

export function deleteOwnerSecret(
  task: SimulationTask,
  deps: OwnerSecretsDeps,
  userId: string,
  name: string,
): ResultAsync<ProjectSecretList, ProjectSecretError> {
  return new ResultAsync(mutate(task, ownerScope(deps, userId), name, null));
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
      if (!validBundle(payload.value, "projectId")) {
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
