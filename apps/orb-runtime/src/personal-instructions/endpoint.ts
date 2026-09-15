import {
  PERSONAL_INSTRUCTIONS_RUNTIME_PATH,
  type PersonalInstructions,
  PersonalInstructionsSchema,
  validatePersonalInstructions,
} from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";

export interface PersonalInstructionsFetchError {
  readonly type: "personal_instructions_fetch_error";
  readonly message: string;
  readonly retryable: boolean;
}

/** Immediate HTTP/JSON adapter boundary. No cache, silent fallback or autonomous retries. */
export async function fetchPersonalInstructions(
  env: BrokerEnv,
  fetcher: typeof fetch = fetch,
): Promise<Result<PersonalInstructions, PersonalInstructionsFetchError>> {
  let response: Response;
  try {
    response = await fetcher(`${env.controlPlaneUrl}${PERSONAL_INSTRUCTIONS_RUNTIME_PATH}`, {
      headers: { authorization: `Bearer ${env.runtimeToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return err({
      type: "personal_instructions_fetch_error",
      message: "Cannot load personal instructions: control plane unavailable",
      retryable: true,
    });
  }
  if (!response.ok)
    return err({
      type: "personal_instructions_fetch_error",
      message: `Cannot load personal instructions: HTTP ${response.status}`,
      retryable: response.status >= 500,
    });
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
    return err({
      type: "personal_instructions_fetch_error",
      message: "Cannot load personal instructions: invalid snapshot",
      retryable: false,
    });
  return ok(body);
}
