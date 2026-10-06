import { err, errAsync, okAsync, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import type { AgentSessionFacade } from "../../domain/agent-ports.ts";
import { StableAgentHandle } from "./handle.ts";

it("acknowledges pending cancellation outside blocked loading and never cold-loads active Abort", async () => {
  let release!: () => void;
  const loading = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const loadingEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let opens = 0;
  const session: AgentSessionFacade = {
    runtimeInstanceId: "native",
    snapshot: () => err({ message: "unused" }),
    liveView: () => null,
    subscribe: () => () => undefined,
    request: () => okAsync({ type: "settings_applied", duplicate: false }),
  };
  const handle = new StableAgentHandle(
    "orb",
    () => {
      opens++;
      entered();
      return ResultAsync.fromSafePromise(loading).map(() => session);
    },
    undefined,
    () => okAsync("cancelled"),
  );
  const pending = handle.request("loading", { type: "set_thinking", thinkingLevel: "off" });
  try {
    await loadingEntered;
    const cancelled = handle.request("abort", { type: "abort", operationId: "inbox:pending" });
    expect(
      await Promise.race([
        cancelled.then((result) => result._unsafeUnwrap()),
        pending.then(() => "loaded"),
      ]),
    ).toMatchObject({ type: "accepted", operationId: "inbox:pending" });
    expect(opens).toBe(1);
  } finally {
    release();
    await pending;
    handle.dispose();
  }
  const unloaded = new StableAgentHandle(
    "other",
    () => {
      opens++;
      return okAsync(session);
    },
    undefined,
    () => okAsync("active"),
  );
  expect(
    (
      await unloaded.request("active", { type: "abort", operationId: "inbox:active" })
    )._unsafeUnwrapErr(),
  ).toMatchObject({ code: "history_unavailable", retryable: true });
  expect(opens).toBe(1);
  unloaded.dispose();
});

it("does not ACK failed cancellation storage or forward a missing pending turn", async () => {
  let requests = 0;
  const handle = new StableAgentHandle(
    "orb",
    () => {
      requests++;
      return errAsync({
        type: "runtime_client_error",
        code: "cancelled",
        answered: true,
        retryable: false,
        message: "unused",
      });
    },
    undefined,
    () =>
      errAsync({
        type: "runtime_client_error",
        code: "history_unavailable",
        answered: true,
        retryable: true,
        message: "storage unavailable",
      }),
  );
  expect(
    (await handle.request("abort", { type: "abort", operationId: "inbox:pending" })).isErr(),
  ).toBe(true);
  expect(requests).toBe(0);
  handle.dispose();
});
