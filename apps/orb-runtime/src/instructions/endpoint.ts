import {
  PERSONAL_INSTRUCTIONS_RUNTIME_PATH,
  type PersonalInstructions,
  PersonalInstructionsSchema,
  PROJECT_INSTRUCTIONS_RUNTIME_PATH,
  validatePersonalInstructions,
} from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";

export interface InstructionsFetchError {
  readonly type: "instructions_fetch_error";
  readonly message: string;
  readonly retryable: boolean;
}
/** One bounded boot read. Both instruction scopes have the same snapshot contract. */
export async function fetchInstructions(
  env: BrokerEnv,
  scope: "personal" | "project",
  fetcher: typeof fetch,
): Promise<Result<PersonalInstructions, InstructionsFetchError>> {
  const path =
    scope === "personal" ? PERSONAL_INSTRUCTIONS_RUNTIME_PATH : PROJECT_INSTRUCTIONS_RUNTIME_PATH;
  const failure = (message: string, retryable: boolean) =>
    err<PersonalInstructions, InstructionsFetchError>({
      type: "instructions_fetch_error",
      message: `Cannot load ${scope} instructions: ${message}`,
      retryable,
    });
  let response: Response;
  try {
    response = await fetcher(`${env.controlPlaneUrl}${path}`, {
      headers: { authorization: `Bearer ${env.runtimeToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return failure("control plane unavailable", true);
  }
  if (!response.ok) return failure(`HTTP ${response.status}`, response.status >= 500);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (
    !Check(PersonalInstructionsSchema, body) ||
    validatePersonalInstructions({ content: body.content }).isErr()
  )
    return failure("invalid snapshot", false);
  return ok(body);
}
