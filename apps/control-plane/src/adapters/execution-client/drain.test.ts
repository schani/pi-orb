import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { EXECUTION_CANCEL_PATH, EXECUTION_EXEC_PATH } from "@pi-orb/protocol";
import { expect, test } from "vitest";
import { RemoteExecutionEnv } from "./env.ts";

for (const frame of [
  '{"type":"not-a-frame"}\n',
  `${JSON.stringify({ type: "output", text: "x".repeat(1024 * 1024) })}\n`,
]) {
  test(`invalid stream awaits remote process drain (${frame.length} bytes)`, async () => {
    let acknowledge!: () => void;
    const drained = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    let requested!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const server = createServer(async (request, response) => {
      request.resume();
      if (request.url === EXECUTION_EXEC_PATH) {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.end(frame);
      } else if (request.url === EXECUTION_CANCEL_PATH) {
        requested();
        await drained;
        response.end('{"ok":true}');
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const env = new RemoteExecutionEnv({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: "token",
      incarnation: "1",
      cwd: "/remote",
    });
    let finished = false;
    const execution = env.exec("unsafe-effect", undefined, BACKGROUND_CONTEXT).then((value) => {
      finished = true;
      return value;
    });
    try {
      const first = await Promise.race([
        cancellation.then(() => "cancel"),
        execution.then(() => "returned"),
      ]);
      expect(first).toBe("cancel");
      expect(finished).toBe(false);
      acknowledge();
      const result = await execution;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("unknown");
    } finally {
      acknowledge();
      await execution;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
