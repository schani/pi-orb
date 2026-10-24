import { createServer } from "node:http";
import { expect, it } from "vitest";
import { runCli } from "../testkit/cli.ts";

it("dispatches send through the guest control-plane route and prints stable retry identity", async () => {
  const orbId = "abcdef00-0000-4000-8000-000000000001";
  const messageId = "abcdef00-0000-4000-8000-000000000002";
  const server = createServer((request, response) => {
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/runtime/v1/orb/send");
    expect(request.headers.authorization).toBe("Bearer test-token");
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      expect(JSON.parse(body)).toEqual({
        v: 1,
        orbId,
        message: "literal <peer>",
        requestId: "fixed",
      });
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ v: 1, orbId, messageId, requestId: "fixed" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");
    const result = await runCli(
      ["send", orbId.toUpperCase(), "literal <peer>", "--request-id", "fixed"],
      {
        env: {
          PATH: process.env.PATH,
          PI_ORB_CONTROL_PLANE_URL: `http://127.0.0.1:${address.port}`,
          PI_ORB_RUNTIME_TOKEN: "test-token",
        },
      },
    );
    expect(result).toEqual({
      code: 0,
      stdout: `Message queued (${messageId}; request-id fixed).\n`,
      stderr: "",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
