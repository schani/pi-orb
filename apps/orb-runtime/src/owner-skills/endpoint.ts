import {
  OWNER_SKILLS_RUNTIME_PATH,
  type OwnerSkillsSnapshot,
  OwnerSkillsSnapshotSchema,
} from "@pi-orb/protocol";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";

export interface OwnerSkillsFetchError {
  readonly type: "owner_skills_fetch_error";
  readonly message: string;
  readonly retryable: boolean;
}

/** One bounded boot read of the orb project owner's skills (docs/owner-skills-secrets.md). */
export async function fetchOwnerSkills(
  env: BrokerEnv,
  fetcher: typeof fetch = fetch,
): Promise<Result<OwnerSkillsSnapshot, OwnerSkillsFetchError>> {
  const failure = (message: string, retryable: boolean) =>
    err<OwnerSkillsSnapshot, OwnerSkillsFetchError>({
      type: "owner_skills_fetch_error",
      message: `Cannot load owner skills: ${message}`,
      retryable,
    });
  const response = await ResultAsync.fromPromise(
    fetcher(`${env.controlPlaneUrl}${OWNER_SKILLS_RUNTIME_PATH}`, {
      headers: { authorization: `Bearer ${env.runtimeToken}` },
      signal: AbortSignal.timeout(10_000),
    }),
    () => undefined,
  );
  if (response.isErr()) return failure("control plane unavailable", true);
  if (!response.value.ok)
    return failure(`HTTP ${response.value.status}`, response.value.status >= 500);
  const body = await ResultAsync.fromPromise(response.value.json(), () => undefined);
  return body.isOk() && Check(OwnerSkillsSnapshotSchema, body.value)
    ? ok(body.value)
    : failure("invalid snapshot", false);
}
