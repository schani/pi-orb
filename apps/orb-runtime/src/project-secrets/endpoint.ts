import {
  PROJECT_SECRETS_RUNTIME_PATH,
  type ProjectSecretSnapshot,
  ProjectSecretSnapshotSchema,
} from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";

export const PROJECT_SECRET_REQUEST_TIMEOUT_MS = 10_000;

export const PROJECT_SECRET_BOOT_RETRY_WINDOW_MS = 180_000;

export interface ProjectSecretFetchError {
  readonly type: "project_secret_fetch_error";
  readonly code: "unavailable" | "unauthorized" | "invalid_response";
  readonly message: string;
  readonly retryable: boolean;
}

/** Immediate runtime adapter boundary: no rejection or raw Error escapes. */
export async function fetchProjectSecretSnapshot(
  env: BrokerEnv,
): Promise<Result<ProjectSecretSnapshot, ProjectSecretFetchError>> {
  const signal = AbortSignal.timeout(PROJECT_SECRET_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${env.controlPlaneUrl}${PROJECT_SECRETS_RUNTIME_PATH}`, {
      method: "GET",
      headers: { authorization: `Bearer ${env.runtimeToken}` },
      signal,
    });
  } catch {
    return err({
      type: "project_secret_fetch_error",
      code: "unavailable",
      message: "control plane project secrets unavailable",
      retryable: true,
    });
  }
  if (response.status === 401) {
    return err({
      type: "project_secret_fetch_error",
      code: "unauthorized",
      message: "runtime is not authorized to read project secrets",
      retryable: false,
    });
  }
  if (!response.ok) {
    return err({
      type: "project_secret_fetch_error",
      code: "unavailable",
      message: `control plane project secrets HTTP ${response.status}`,
      retryable: response.status >= 500,
    });
  }
  const body: unknown = await response.json().catch(() => null);
  if (!Check(ProjectSecretSnapshotSchema, body)) {
    return err({
      type: "project_secret_fetch_error",
      code: "invalid_response",
      message: "malformed project secret snapshot",
      retryable: false,
    });
  }
  return ok(body);
}

export interface ProjectSecretBootRetryOptions {
  readonly retryWindowMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Bootstrap has two expected short races: a newly provisioned host may ask
 * before its bearer hash commits, and a new runtime Cloud Run revision may ask
 * before the browser role finishes the same release's migration. Retry only
 * those availability/authorization outcomes inside one bounded boot window;
 * malformed data remains terminal immediately.
 */
export async function fetchProjectSecretSnapshotAtBoot(
  env: BrokerEnv,
  options: ProjectSecretBootRetryOptions = {},
): Promise<Result<ProjectSecretSnapshot, ProjectSecretFetchError>> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.retryWindowMs ?? PROJECT_SECRET_BOOT_RETRY_WINDOW_MS);
  let last: ProjectSecretFetchError | null = null;
  do {
    const result = await fetchProjectSecretSnapshot(env);
    if (result.isOk()) return result;
    last = result.error;
    if (last.code === "invalid_response" || now() >= deadline) return result;
    await sleep(1_000);
  } while (now() <= deadline);
  return err(
    last ?? {
      type: "project_secret_fetch_error",
      code: "unavailable",
      message: "control plane project secrets unavailable",
      retryable: true,
    },
  );
}
