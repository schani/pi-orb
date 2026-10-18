import { expect, it } from "vitest";
import { buildRuntimeServer } from "../http/server.ts";
import type { TerminalManager } from "../terminal/manager.ts";
import { ComposedClaudeFixture } from "../testkit/claude-composed.ts";
import { sendAlert } from "./command.ts";

const token = "test-secret";
async function fixture() {
  const f = new ComposedClaudeFixture();
  expect((await f.attach()).isOk()).toBe(true);
  const app = buildRuntimeServer(
    f.agent,
    { closeAll: () => undefined } as unknown as TerminalManager,
    token,
  );
  return { f, app };
}

it("sends authenticated CLI alerts through the loopback listener, including maximum escaped and Unicode bodies", async () => {
  const { f, app } = await fixture();
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("missing listener");
    for (const [requestId, message] of [
      ["loopback-id", "real HTTP"],
      ["r".repeat(128), "\u0001".repeat(4096)],
      ["emoji-id", "🔔".repeat(2048)],
    ] as const) {
      const response = (
        await sendAlert({ message, requestId }, { token, port: address.port })
      )._unsafeUnwrap();
      expect(response.duplicate).toBe(false);
      expect(f.agent.replicationSnapshot()._unsafeUnwrap().records).toContainEqual(
        expect.objectContaining({
          id: response.id,
          type: "event",
          eventType: "pi-orb.alert",
          content: [{ type: "text", text: message }],
          overflow: { message, requestId },
        }),
      );
    }
  } finally {
    await app.close();
    f.dispose();
  }
});

it("replays the CLI identity after a lost successful response without appending twice", async () => {
  const { f, app } = await fixture();
  try {
    let loseResponse = true;
    const transport: typeof fetch = async (_url, init) => {
      const reply = await app.inject({
        method: "POST",
        url: "/v1/alert",
        headers: {
          authorization: new Headers(init?.headers).get("authorization") ?? "",
          "content-type": "application/json",
        },
        payload: init?.body as string,
      });
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost");
      }
      return new Response(reply.body, { status: reply.statusCode });
    };
    const input = { message: "heads up", requestId: "stable-identity" };
    expect(
      (await sendAlert(input, { token, port: 8080, fetch: transport }))._unsafeUnwrapErr(),
    ).toMatchObject({ code: "unknown_outcome", requestId: input.requestId });
    expect(
      (await sendAlert(input, { token, port: 8080, fetch: transport }))._unsafeUnwrap(),
    ).toMatchObject({ duplicate: true });
    expect(
      f.agent
        .replicationSnapshot()
        ._unsafeUnwrap()
        .records.filter(
          (record) => record.type === "event" && record.overflow.requestId === input.requestId,
        ),
    ).toHaveLength(1);
  } finally {
    await app.close();
    f.dispose();
  }
});
