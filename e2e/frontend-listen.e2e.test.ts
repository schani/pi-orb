import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { expect, it, vi } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";

it("reports listen failures through the test framework and releases its error listener", async () => {
  const httpServer = createHttpServer();
  const listen = vi.spyOn(httpServer, "listen").mockImplementation(() => {
    httpServer.emit("error", new Error("synthetic bind failure"));
    return httpServer;
  });
  try {
    await expect(listenFrontend({ httpServer })).rejects.toThrow("synthetic bind failure");
    expect(httpServer.listenerCount("error")).toBe(0);
    await expect(listenFrontend({ httpServer: null })).rejects.toThrow("requires an HTTP server");
  } finally {
    listen.mockRestore();
  }
});

it("asks the owned Node server for an ephemeral port, never Vite's preview-port fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-orb-frontend-port-"));
  const vite = await createServer({
    root,
    configFile: false,
    server: { host: "127.0.0.1", port: 0 },
  });
  if (vite.httpServer === null) throw new Error("Expected an HTTP server");
  const listen = vi.spyOn(vite.httpServer, "listen");
  try {
    await listenFrontend(vite);
    expect(listen.mock.calls[0]?.[0]).toBe(0);
    const address = vite.httpServer.address();
    expect(address).not.toBeNull();
    expect(typeof address).toBe("object");
  } finally {
    listen.mockRestore();
    await vite.close();
    await rm(root, { recursive: true, force: true });
  }
});
