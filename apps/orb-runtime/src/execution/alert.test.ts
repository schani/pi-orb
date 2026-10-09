import { okAsync } from "neverthrow";
import { expect, test } from "vitest";
import { buildExecutionServer } from "./server.ts";

test("retained alert CLI admission forwards without an incarnation header or model input", async () => {
  const admissions: unknown[] = [];
  const app = buildExecutionServer({
    token: "token",
    incarnation: "3",
    cwd: "/unused",
    appendAlert: (input) => {
      admissions.push(input);
      return okAsync({ v: 1 as const, id: "record", duplicate: admissions.length > 1 });
    },
  });
  try {
    const call = (
      authorization = "Bearer token",
      payload: Record<string, unknown> = { v: 1, requestId: "request", message: "busy alert" },
    ) =>
      app.inject({
        method: "POST",
        url: "/v1/alert",
        headers: { authorization },
        payload,
      });
    expect((await call("Bearer wrong")).statusCode).toBe(401);
    expect(
      (await call("Bearer token", { v: 1, requestId: "request", message: " " })).statusCode,
    ).toBe(400);
    expect((await call()).json()).toEqual({ v: 1, id: "record", duplicate: false });
    expect((await call()).json()).toEqual({ v: 1, id: "record", duplicate: true });
    expect(admissions).toEqual([
      { v: 1, requestId: "request", message: "busy alert" },
      { v: 1, requestId: "request", message: "busy alert" },
    ]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/execution/rpc",
          headers: { authorization: "Bearer token" },
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await app.close();
  }
});
