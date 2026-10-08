import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { startInferenceWireProxy } from "./inference-wire-proxy.ts";
import { captureSubagentFailure } from "./subagent-failure-evidence.ts";

it("forwards the fixture wire once with exact bytes and end-to-end headers, not hop headers", async () => {
  const bytes = gzipSync(Buffer.from(JSON.stringify({ model: "gpt-6.1-sol", input: [] })));
  const sse = 'event: response.created\ndata: {"id":"public"}\n\ndata: [DONE]\n\n';
  let calls = 0;
  let received:
    | {
        bytes: Buffer;
        method: string | undefined;
        headers: Record<string, unknown>;
        path: string | undefined;
      }
    | undefined;
  const server = createServer((req, res) => {
    calls++;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received = {
        bytes: Buffer.concat(chunks),
        method: req.method,
        headers: req.headers,
        path: req.url,
      };
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-public": "retained",
        connection: "x-hop-response",
        "x-hop-response": "drop",
      });
      res.end(sse);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test listener missing");
  const proxy = (
    await startInferenceWireProxy(`http://127.0.0.1:${address.port}/backend-api`)
  )._unsafeUnwrap();
  try {
    const response = await new Promise<{ body: Buffer; headers: Record<string, unknown> }>(
      (resolve, reject) => {
        const client = request(
          `${proxy.baseUrl}/codex/responses`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer SECRET",
              "content-encoding": "gzip",
              "content-type": "application/json",
              connection: "x-hop-request",
              "x-hop-request": "drop",
              "x-public": "retained",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("error", reject);
            res.on("end", () => resolve({ body: Buffer.concat(chunks), headers: res.headers }));
          },
        );
        client.on("error", reject);
        client.end(bytes);
      },
    );
    await proxy.idle();
    expect(calls).toBe(1);
    expect(received).toMatchObject({
      bytes,
      method: "POST",
      path: "/backend-api/codex/responses",
      headers: {
        authorization: "Bearer SECRET",
        "content-encoding": "gzip",
        "content-type": "application/json",
        "x-public": "retained",
      },
    });
    expect(received?.headers["x-hop-request"]).toBeUndefined();
    expect(response.body).toEqual(Buffer.from(sse));
    expect(response.headers["x-public"]).toBe("retained");
    expect(response.headers["x-hop-response"]).toBeUndefined();
    expect(JSON.stringify(proxy.snapshot())).not.toContain("SECRET");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("freezes the failure wire snapshot before a held probe and fixture cleanup", async () => {
  let entered!: () => void;
  const upstreamEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const proxy = (
    await startInferenceWireProxy("https://fixture.invalid", {
      fetch: async (_url, init) => {
        entered();
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("SECRET", "AbortError")),
            { once: true },
          ),
        );
      },
    })
  )._unsafeUnwrap();
  const root = mkdtempSync(join(tmpdir(), "wire-capture-integration-"));
  const artifact = join(root, "failure.json");
  const pending = fetch(`${proxy.baseUrl}/codex/responses`, { method: "POST", body: "{}" }).then(
    () => undefined,
    () => undefined,
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let probing!: () => void;
  const probeEntered = new Promise<void>((resolve) => {
    probing = resolve;
  });
  try {
    await upstreamEntered;
    const capture = captureSubagentFailure({
      root,
      orb: "c01e5202-cc89-468e-9b96-0123456789ab",
      phase: "profiles",
      artifact,
      logs: [],
      inferenceWire: proxy.snapshot(),
      probes: {
        health: async () => {
          probing();
          await held;
          return { status: 200, body: {} };
        },
      },
    });
    await probeEntered;
    const before = JSON.parse(readFileSync(artifact, "utf8"));
    expect(before.inferenceWire[0]).toMatchObject({
      method: "POST",
      headersAt: null,
      terminal: null,
    });
    expect(before.inferenceWire[0].bodyArrivedAt).not.toBeNull();
    expect(before.inferenceWire[0].upstreamEnteredAt).not.toBeNull();
    expect((await proxy.close()).isOk()).toBe(true);
    await pending;
    expect(proxy.snapshot()[0]?.terminal).toBe("fixture_cleanup");
    release();
    expect((await capture).isOk()).toBe(true);
    expect(JSON.parse(readFileSync(artifact, "utf8")).inferenceWire).toEqual(before.inferenceWire);
  } finally {
    release();
    await proxy.close();
    await pending;
    rmSync(root, { recursive: true, force: true });
  }
});
