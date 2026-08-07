import {
  ORB_NAME_TRIGGER_PATH,
  type OrbNameTrigger,
  OrbNameTriggerResponseSchema,
} from "@pi-orb/protocol";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";

export interface NamingTriggerError {
  readonly type: "naming_trigger_error";
  readonly message: string;
  readonly retryable: boolean;
}

export function triggerOrbName(
  broker: BrokerEnv,
  body: OrbNameTrigger,
): ResultAsync<void, NamingTriggerError> {
  return ResultAsync.fromPromise(
    fetch(`${broker.controlPlaneUrl}${ORB_NAME_TRIGGER_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${broker.runtimeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    (error) => ({
      type: "naming_trigger_error" as const,
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    }),
  ).andThen((response) =>
    ResultAsync.fromPromise(response.json() as Promise<unknown>, (error) => ({
      type: "naming_trigger_error" as const,
      message: error instanceof Error ? error.message : String(error),
      retryable: response.status >= 500,
    })).andThen((payload) => {
      if (response.ok && Check(OrbNameTriggerResponseSchema, payload)) return okAsync(undefined);
      return errAsync({
        type: "naming_trigger_error" as const,
        message: `naming HTTP ${response.status}`,
        retryable: response.status >= 500,
      });
    }),
  );
}
