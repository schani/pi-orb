import { setTimeout } from "node:timers/promises";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { BrokerEnv } from "./broker/endpoint.ts";

export interface InitialCheckoutError {
  readonly type: "initial_checkout_error";
  readonly code:
    | "checkout_admission_revoked"
    | "resource_acquisition_failed"
    | "checkout_unavailable"
    | "checkout_cancelled";
  readonly message: string;
}
interface PollOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly checkpoint?: (name: string) => Promise<void>;
  readonly fetch?: typeof fetch;
}
const failure = (code: InitialCheckoutError["code"], message: string): InitialCheckoutError => ({
  type: "initial_checkout_error",
  code,
  message,
});

/** Fresh checkout only. The caller must bypass this entirely for retained workspaces. */
export async function awaitInitialCheckoutCommit(
  environment: NodeJS.ProcessEnv,
  broker: BrokerEnv | null,
  incarnation: string,
  options: PollOptions = {},
): Promise<Result<string | undefined, InitialCheckoutError>> {
  if (options.signal?.aborted)
    return err(failure("checkout_cancelled", "initial checkout cancelled"));
  const known = environment.PI_ORB_INITIAL_CHECKOUT_COMMIT;
  if (known)
    return /^[a-f0-9]{40}$/.test(known)
      ? ok(known)
      : err(failure("resource_acquisition_failed", "invalid initial checkout commit"));
  if (environment.PI_ORB_AWAIT_INITIAL_CHECKOUT_COMMIT !== "1") return ok(undefined);
  if (!broker)
    return err(failure("checkout_unavailable", "initial checkout broker is unavailable"));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 20 * 60_000);
  const sleep = options.sleep ?? ((ms, signal) => setTimeout(ms, undefined, { signal }));
  // A freshly launched runtime can precede the control plane's bearer attachment transaction.
  let authenticated = false;
  while (now() < deadline) {
    if (options.signal?.aborted)
      return err(failure("checkout_cancelled", "initial checkout cancelled"));
    const checkpoint = await ResultAsync.fromThrowable(
      async () => {
        await options.checkpoint?.("checkout.pin-poll");
      },
      () => failure("checkout_cancelled", "initial checkout cancelled"),
    )();
    if (checkpoint.isErr()) return err(checkpoint.error);
    if (options.signal?.aborted)
      return err(failure("checkout_cancelled", "initial checkout cancelled"));
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - now())));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await ResultAsync.fromThrowable(
      async () =>
        (options.fetch ?? fetch)(
          `${broker.controlPlaneUrl.replace(/\/$/, "")}/api/runtime/initial-checkout`,
          {
            headers: {
              Authorization: `Bearer ${broker.runtimeToken}`,
              "x-orb-incarnation": incarnation,
            },
            signal,
          },
        ),
      () => failure("checkout_unavailable", "initial checkout request unavailable"),
    )();
    if (options.signal?.aborted)
      return err(failure("checkout_cancelled", "initial checkout cancelled"));
    if (response.isOk() && (response.value.status !== 401 || authenticated)) {
      const res = response.value;
      if (res.status === 409 || res.status === 401 || res.status === 403)
        return err(failure("checkout_admission_revoked", "initial checkout admission revoked"));
      const body = await ResultAsync.fromThrowable(
        async () => res.json() as Promise<unknown>,
        () => failure("checkout_unavailable", "invalid initial checkout response"),
      )();
      if (body.isErr()) return err(body.error);
      if (options.signal?.aborted)
        return err(failure("checkout_cancelled", "initial checkout cancelled"));
      const value = body.value;
      if (res.status === 202) authenticated = true;
      if (typeof value !== "object" || value === null)
        return err(failure("checkout_unavailable", "invalid initial checkout response"));
      if (
        res.status === 200 &&
        "commitSha" in value &&
        typeof value.commitSha === "string" &&
        /^[a-f0-9]{40}$/.test(value.commitSha)
      )
        return ok(value.commitSha);
      if (res.status === 503 && "error" in value && value.error === "resource_acquisition_failed")
        return err(
          failure("resource_acquisition_failed", "repository resources could not be acquired"),
        );
      if (
        !(res.status === 202 && "pending" in value && value.pending === true) &&
        !(res.status === 503 && "error" in value && value.error === "unavailable")
      )
        return err(failure("checkout_unavailable", "initial checkout response rejected"));
    }
    const waited = await ResultAsync.fromThrowable(
      async () => sleep(Math.min(500, Math.max(0, deadline - now())), options.signal),
      () => failure("checkout_cancelled", "initial checkout cancelled"),
    )();
    if (waited.isErr()) return err(waited.error);
  }
  return err(failure("checkout_unavailable", "initial checkout readiness deadline exceeded"));
}
