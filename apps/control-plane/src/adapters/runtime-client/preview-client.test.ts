import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { NoSimulationTask } from "determined";
import { ok, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { PreviewRoute } from "../../domain/preview.ts";
import { NodePreviewClient } from "./preview-client.ts";

it("streams binary HTTP once, preserving query and separate application Authorization", async () => {
  let attempts = 0;
  let receivedUrl: string | undefined;
  let receivedHeaders: import("node:http").IncomingHttpHeaders = {};
  const server = createServer((request, response) => {
    attempts++;
    receivedUrl = request.url;
    receivedHeaders = request.headers;
    response.writeHead(201, {
      "content-type": "application/octet-stream",
      "set-cookie": ["a=1", "b=2"],
    });
    request.pipe(response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("invalid fixture address");
  const route: PreviewRoute = {
    target: {
      orbId: "orb-a",
      port: 5173,
      registrationId: "r1",
      incarnation: 1,
      executionId: "boot-1",
      runtimeInstanceId: "rt-1",
    },
    baseUrl: `http://127.0.0.1:${address.port}`,
    runtimeTokenHash: "runtime-hash",
    origin: "https://preview.test",
    expiresAt: Date.now() + 60000,
  };
  let sent = false;
  const client = new NodePreviewClient();
  try {
    const result = await client.openHttp(
      new NoSimulationTask("preview-adapter", false),
      route,
      {
        method: "POST",
        path: "/deep?q=a%2Fb",
        headers: [["authorization", "Bearer app-token"]],
        body: {
          read: async () => {
            const { okAsync } = await import("neverthrow");
            if (sent) return okAsync(null);
            sent = true;
            return okAsync(new Uint8Array([0, 255, 2]));
          },
        },
      },
      { signal: new AbortController().signal },
    );
    const response = result._unsafeUnwrap();
    expect(response.status).toBe(201);
    const chunks: number[] = [];
    for (;;) {
      const chunk = (await response.body.read())._unsafeUnwrap();
      if (chunk === null) break;
      chunks.push(...chunk);
    }
    expect(chunks).toEqual([0, 255, 2]);
    expect(response.headers.filter(([name]) => name.toLowerCase() === "set-cookie")).toHaveLength(
      2,
    );
    response.dispose();
    expect(attempts).toBe(1);
    expect(receivedUrl).toBe("/v1/preview/5173");
    expect(
      Buffer.from(String(receivedHeaders["x-pi-orb-preview-path"]), "base64url").toString(),
    ).toBe("/deep?q=a%2Fb");
    expect(receivedHeaders.authorization).toBe("Bearer app-token");
    expect(receivedHeaders["x-pi-orb-preview-application-authorization"]).toBeUndefined();
    const envelope = String(receivedHeaders["x-pi-orb-preview-admission"]);
    const [payload, signature] = envelope.split(".");
    expect(signature).toBe(
      createHmac("sha256", "runtime-hash")
        .update(`pi-orb-preview-admission-v1\n${payload}`)
        .digest("base64url"),
    );
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString()).target.registrationId).toBe(
      "r1",
    );
    expect(envelope).not.toContain("runtime-hash");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("cannot escape the private preview endpoint through path normalization", async () => {
  let receivedPath: string | undefined;
  let forwardedPath: string | undefined;
  const server = createServer((request, response) => {
    receivedPath = request.url;
    forwardedPath = String(request.headers["x-pi-orb-preview-path"] ?? "");
    request.resume();
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("invalid fixture address");
  const route: PreviewRoute = {
    target: {
      orbId: "orb-a",
      port: 5173,
      registrationId: "r1",
      incarnation: 1,
      executionId: "boot-1",
      runtimeInstanceId: "rt-1",
    },
    baseUrl: `http://127.0.0.1:${address.port}`,
    runtimeTokenHash: "hash",
    origin: "https://preview.test",
    expiresAt: Date.now() + 60000,
  };
  const path = "/../../v1/history?q=a%2Fb";
  try {
    const response = (
      await new NodePreviewClient().openHttp(
        new NoSimulationTask("preview-path-fence", false),
        route,
        { method: "GET", path, headers: [], body: { read: () => Promise.resolve(ok(null)) } },
        { signal: new AbortController().signal },
      )
    )._unsafeUnwrap();
    await response.body.read();
    response.dispose();
    expect(receivedPath).toBe("/v1/preview/5173");
    expect(Buffer.from(forwardedPath ?? "", "base64url").toString()).toBe(path);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([
  ["target_refused", true],
  ["unknown_fault", false],
] as const)(
  "consumes only typed private forwarding error marker %s",
  async (marker, expectedError) => {
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(502, { "x-pi-orb-preview-error": marker });
      response.end("application status");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("invalid fixture address");
    const route: PreviewRoute = {
      target: {
        orbId: "orb-a",
        port: 5173,
        registrationId: "r1",
        incarnation: 1,
        executionId: "boot-1",
        runtimeInstanceId: "rt-1",
      },
      baseUrl: `http://127.0.0.1:${address.port}`,
      runtimeTokenHash: "hash",
      origin: "https://preview.test",
      expiresAt: Date.now() + 60000,
    };
    try {
      const result = await new NodePreviewClient().openHttp(
        new NoSimulationTask("preview-marker", false),
        route,
        { method: "GET", path: "/", headers: [], body: { read: () => Promise.resolve(ok(null)) } },
        { signal: new AbortController().signal },
      );
      expect(result.isErr()).toBe(expectedError);
      if (result.isErr()) expect(result.error.code).toBe("target_refused");
      else {
        expect(result.value.status).toBe(502);
        expect(
          result.value.headers.some(([name]) => name.toLowerCase() === "x-pi-orb-preview-error"),
        ).toBe(false);
        result.value.dispose();
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it("rejects oversized original paths before opening a private connection", async () => {
  const route: PreviewRoute = {
    target: {
      orbId: "orb-a",
      port: 5173,
      registrationId: "r1",
      incarnation: 1,
      executionId: "boot-1",
      runtimeInstanceId: "rt-1",
    },
    baseUrl: "http://127.0.0.1:1",
    runtimeTokenHash: "hash",
    origin: "https://preview.test",
    expiresAt: Date.now() + 60000,
  };
  const result = await new NodePreviewClient().openHttp(
    new NoSimulationTask("preview-path-limit", false),
    route,
    {
      method: "GET",
      path: `/${"x".repeat(12288)}`,
      headers: [],
      body: { read: () => Promise.resolve(ok(null)) },
    },
    { signal: new AbortController().signal },
  );
  expect(result.isErr() && result.error.code).toBe("invalid_request");
});

it("never retries a mutating request whose accepted response is lost", async () => {
  let accepted = 0;
  const server = createServer((request) => {
    request.resume();
    request.once("end", () => {
      accepted++;
      request.socket.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("invalid fixture address");
  const route: PreviewRoute = {
    target: {
      orbId: "orb-a",
      port: 5173,
      registrationId: "r1",
      incarnation: 1,
      executionId: "boot-1",
      runtimeInstanceId: "rt-1",
    },
    baseUrl: `http://127.0.0.1:${address.port}`,
    runtimeTokenHash: "hash",
    origin: "https://preview.test",
    expiresAt: Date.now() + 60000,
  };
  try {
    const result = await new NodePreviewClient().openHttp(
      new NoSimulationTask("lost-response", false),
      route,
      {
        method: "POST",
        path: "/mutate",
        headers: [],
        body: { read: () => Promise.resolve(okAsync(null)) },
      },
      { signal: new AbortController().signal },
    );
    expect(result.isErr() && result.error.code).toBe("upstream_failed");
    expect(accepted).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("preserves the upstream WebSocket close outcome", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  let receivedPath: string | undefined;
  let forwardedPath = "";
  sockets.on("connection", (socket, request) => {
    receivedPath = request.url;
    forwardedPath = String(request.headers["x-pi-orb-preview-path"] ?? "");
    socket.close(1000, "complete");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("invalid fixture address");
  const route: PreviewRoute = {
    target: {
      orbId: "orb-a",
      port: 5173,
      registrationId: "r1",
      incarnation: 1,
      executionId: "boot-1",
      runtimeInstanceId: "rt-1",
    },
    baseUrl: `http://127.0.0.1:${address.port}`,
    runtimeTokenHash: "hash",
    origin: "https://preview.test",
    expiresAt: Date.now() + 60000,
  };
  try {
    const result = (
      await new NodePreviewClient().openWebSocket(
        new NoSimulationTask("close-preview", false),
        route,
        "/../../v1/history?q=a%2Fb",
        [],
        [],
        { signal: new AbortController().signal },
      )
    )._unsafeUnwrap();
    expect((await result.read())._unsafeUnwrap()).toBeNull();
    expect(result.closeInfo).toEqual({ code: 1000, reason: "complete" });
    expect(receivedPath).toBe("/v1/preview/5173");
    expect(Buffer.from(forwardedPath, "base64url").toString()).toBe("/../../v1/history?q=a%2Fb");
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("cancels a pending WebSocket upgrade with a typed outcome", async () => {
  let accepted!: () => void;
  let ended!: () => void;
  const acceptance = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const ending = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const server = createServer();
  let upgraded: import("node:stream").Duplex | undefined;
  server.on("upgrade", (_request, socket) => {
    upgraded = socket;
    socket.resume();
    socket.once("end", () => socket.end());
    socket.once("close", ended);
    accepted();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("invalid fixture address");
  const route: PreviewRoute = {
    target: {
      orbId: "orb-a",
      port: 5173,
      registrationId: "r1",
      incarnation: 1,
      executionId: "boot-1",
      runtimeInstanceId: "rt-1",
    },
    baseUrl: `http://127.0.0.1:${address.port}`,
    runtimeTokenHash: "hash",
    origin: "https://preview.test",
    expiresAt: Date.now() + 60000,
  };
  const controller = new AbortController();
  try {
    const pending = new NodePreviewClient().openWebSocket(
      new NoSimulationTask("cancel-ws-preview", false),
      route,
      "/silent",
      [],
      [],
      { signal: controller.signal },
    );
    await acceptance;
    controller.abort();
    const result = await pending;
    expect(result.isErr() && result.error.code).toBe("cancelled");
    await ending;
  } finally {
    upgraded?.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("aborts a pending header read and closes the upstream socket", async () => {
  let accepted!: () => void;
  let ended!: () => void;
  const acceptance = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const ending = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const server = createServer((request) => {
    request.socket.once("close", ended);
    request.resume();
    accepted();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("invalid fixture address");
  const route: PreviewRoute = {
    target: {
      orbId: "orb-a",
      port: 5173,
      registrationId: "r1",
      incarnation: 1,
      executionId: "boot-1",
      runtimeInstanceId: "rt-1",
    },
    baseUrl: `http://127.0.0.1:${address.port}`,
    runtimeTokenHash: "hash",
    origin: "https://preview.test",
    expiresAt: Date.now() + 60000,
  };
  const controller = new AbortController();
  try {
    const pending = new NodePreviewClient().openHttp(
      new NoSimulationTask("cancel-preview", false),
      route,
      {
        method: "GET",
        path: "/silent",
        headers: [],
        body: { read: () => Promise.resolve(okAsync(null)) },
      },
      { signal: controller.signal },
    );
    await acceptance;
    controller.abort();
    const result = await pending;
    expect(result.isErr() && result.error.code).toBe("cancelled");
    await ending;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
