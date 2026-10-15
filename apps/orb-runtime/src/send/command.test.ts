import { expect, it } from "vitest";
import { parseSendArgs, sendMessage } from "./command.ts";

const orbId = "00000000-0000-4000-8000-000000000001";
it("requires a target and one message and preserves explicit retry identity", () => {
  expect(parseSendArgs([orbId, "hi", "--request-id", "fixed"])._unsafeUnwrap()).toEqual({
    orbId,
    message: "hi",
    requestId: "fixed",
  });
  for (const args of [
    [],
    [orbId],
    [orbId, " "],
    ["bad", "hi"],
    [orbId, "hi", "extra"],
    [orbId, "hi", "--request-id", ""],
  ])
    expect(parseSendArgs(args).isErr()).toBe(true);
});
it("posts to the control plane with bound runtime auth and reports request identity on lost acknowledgement", async () => {
  const input = { orbId, message: "hi", requestId: "fixed" };
  const result = await sendMessage(input, {
    baseUrl: "http://control",
    token: "secret",
    fetch: async (url, init) => {
      expect(url).toBe("http://control/runtime/v1/orb/send");
      expect(init?.headers).toMatchObject({ authorization: "Bearer secret" });
      expect(JSON.parse(init?.body as string)).toEqual({ v: 1, ...input });
      throw new Error("lost acknowledgement");
    },
  });
  expect(result._unsafeUnwrapErr()).toMatchObject({ code: "unknown_outcome", requestId: "fixed" });
});
it("keeps HTTP 5xx, malformed acknowledgements and invalid JSON ambiguous", async () => {
  for (const response of [
    new Response("{}", { status: 503 }),
    new Response("{}", { status: 202 }),
    new Response("broken", { status: 202 }),
  ]) {
    expect(
      (
        await sendMessage(
          { orbId, message: "hi", requestId: "fixed" },
          {
            baseUrl: "http://control",
            token: "secret",
            fetch: async () => response,
          },
        )
      )._unsafeUnwrapErr(),
    ).toMatchObject({ code: "unknown_outcome", requestId: "fixed" });
  }
});

it("canonicalizes mixed-case UUIDs before retry identity and acknowledgement checks", () => {
  expect(parseSendArgs(["ABCDEF00-0000-4000-8000-000000000001", "hi"])._unsafeUnwrap().orbId).toBe(
    "abcdef00-0000-4000-8000-000000000001",
  );
});
