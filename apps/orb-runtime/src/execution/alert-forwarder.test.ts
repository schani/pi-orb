import { expect, test } from "vitest";
import { forwardExecutionAlert } from "./alert-forwarder.ts";

test("forwards alert to scoped central admission with token and incarnation", async () => {
  let observed: { url: unknown; init: RequestInit | undefined } | undefined;
  const input = { v: 1 as const, message: "private alert", requestId: "request" };
  const result = await forwardExecutionAlert(
    {
      controlPlaneUrl: "http://central",
      token: "secret",
      incarnation: "3",
      fetch: async (url, init) => {
        observed = { url, init };
        return Response.json({ v: 1, id: "record", duplicate: true });
      },
    },
    input,
  );
  expect(result.isOk() && result.value).toEqual({ v: 1, id: "record", duplicate: true });
  expect(observed?.url).toBe("http://central/api/runtime/alert");
  expect(observed?.init?.headers).toEqual({
    authorization: "Bearer secret",
    "x-orb-incarnation": "3",
    "content-type": "application/json",
  });
  expect(observed?.init?.body).toBe(JSON.stringify(input));
});

test("central rejection and unavailable outcomes do not expose response bodies or thrown secrets", async () => {
  for (const status of [409, 503]) {
    const result = await forwardExecutionAlert(
      {
        controlPlaneUrl: "http://central",
        token: "secret",
        incarnation: "3",
        fetch: async () => Response.json({ message: "SECRET" }, { status }),
      },
      { v: 1, message: "alert", requestId: "request" },
    );
    expect(result.isErr() && result.error).toEqual({
      code: status === 409 ? "conflict" : "unavailable",
      message: `central alert admission HTTP ${status}`,
    });
  }
  const result = await forwardExecutionAlert(
    {
      controlPlaneUrl: "http://central",
      token: "secret",
      incarnation: "3",
      fetch: async () => {
        throw new Error("SECRET");
      },
    },
    { v: 1, message: "alert", requestId: "request" },
  );
  expect(result.isErr() && result.error.message).toBe("central alert admission unavailable");
});
