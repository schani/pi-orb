import { createServer } from "node:http";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { HttpMcpTransport } from "./transport.ts";

it("never forwards configured credentials to an HTTP redirect target", async () => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(307, { location: "/unexpected" }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  try {
    const result = await new HttpMcpTransport(`http://127.0.0.1:${address.port}/mcp`, {
      Authorization: "Bearer synthetic",
    }).connect(new NoSimulationTask("redirect", false), AbortSignal.timeout(5000));
    expect(result.isErr()).toBe(true);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => path === "/mcp")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
