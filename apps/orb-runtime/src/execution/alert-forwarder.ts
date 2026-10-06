import {
  type RuntimeAlertRequest,
  type RuntimeAlertResponse,
  RuntimeAlertResponseSchema,
} from "@pi-orb/protocol";
import { err, ok, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";

type AlertForwardError = { readonly code: "conflict" | "unavailable"; readonly message: string };
export function forwardExecutionAlert(
  options: {
    readonly controlPlaneUrl: string;
    readonly token: string;
    readonly incarnation: string;
    readonly fetch?: typeof fetch;
  },
  input: RuntimeAlertRequest,
): ResultAsync<RuntimeAlertResponse, AlertForwardError> {
  return ResultAsync.fromPromise(
    Promise.resolve().then(async () => {
      const response = await (options.fetch ?? fetch)(
        `${options.controlPlaneUrl}/api/runtime/alert`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.token}`,
            "x-orb-incarnation": options.incarnation,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok)
        return err<RuntimeAlertResponse, AlertForwardError>({
          code: response.status === 409 ? "conflict" : "unavailable",
          message: `central alert admission HTTP ${response.status}`,
        });
      const body: unknown = await response.json();
      return Check(RuntimeAlertResponseSchema, body)
        ? ok<RuntimeAlertResponse, AlertForwardError>(body)
        : err<RuntimeAlertResponse, AlertForwardError>({
            code: "unavailable",
            message: "invalid central alert response",
          });
    }),
    (): AlertForwardError => ({
      code: "unavailable",
      message: "central alert admission unavailable",
    }),
  ).andThen((result) => result);
}
