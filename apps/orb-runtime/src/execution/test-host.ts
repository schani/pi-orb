import { buildExecutionServer } from "./server.ts";

const cwd = process.env.EXECUTION_TEST_CWD;
if (!cwd) process.exit(1);
const app = buildExecutionServer({
  token: "test-token",
  incarnation: "7",
  cwd,
});
await app.listen({ port: 0, host: "127.0.0.1" });
const address = app.server.address();
if (address && typeof address !== "string")
  process.send?.({ port: address.port, pid: process.pid });
process.on("SIGTERM", () => {
  void app.close().then(() => process.exit(0));
});
