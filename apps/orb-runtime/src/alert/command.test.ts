import { expect, it } from "vitest";
import { parseAlertArgs, sendAlert } from "./command.ts";

it("requires one message and optionally preserves caller request identity", () => {
  expect(parseAlertArgs([]).isErr()).toBe(true);
  expect(parseAlertArgs(["  "]).isErr()).toBe(true);
  expect(parseAlertArgs(["hello", "--request-id", "request-a"])._unsafeUnwrap()).toEqual({
    message: "hello",
    requestId: "request-a",
  });
  expect(parseAlertArgs(["a", "b"]).isErr()).toBe(true);
});

it("reports lost response as unknown outcome with replay identity", async () => {
  const result = await sendAlert(
    { message: "hi", requestId: "fixed" },
    {
      token: "secret",
      port: 8080,
      fetch: async () => {
        throw new Error("connection dropped");
      },
    },
  );
  expect(result._unsafeUnwrapErr()).toMatchObject({ code: "unknown_outcome", requestId: "fixed" });
});
