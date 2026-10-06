import { okAsync, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { StableAgentHandle } from "./handle.ts";

it("serializes unload with new admissions, without revoking the conversation handle", async () => {
  let release!: () => void;
  const closing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const handle = new StableAgentHandle("orb", () => {
    throw new Error("unused");
  });
  const unload = handle.admit(() =>
    ResultAsync.fromPromise(closing, () => ({
      type: "runtime_client_error" as const,
      code: "cancelled" as const,
      answered: true,
      retryable: false,
      message: "cancelled",
    })).map(() => {
      events.push("closed");
      return undefined;
    }),
  );
  const work = handle.admit(() => {
    events.push("opened");
    return okAsync(undefined);
  });
  expect(events).toEqual([]);
  release();
  (await unload)._unsafeUnwrap();
  (await work)._unsafeUnwrap();
  expect(events).toEqual(["closed", "opened"]);
});
