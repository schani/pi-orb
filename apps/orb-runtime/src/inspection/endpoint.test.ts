import { Readable } from "node:stream";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrokerEnv } from "../broker/endpoint.ts";
import { HttpOrbInspectionEndpoint, INSPECTION_REQUEST_TIMEOUT_MS } from "./endpoint.ts";

const env: BrokerEnv = {
  controlPlaneUrl: "https://runtime.example",
  runtimeToken: "runtime-secret",
};
const task = new NoSimulationTask("inspection endpoint test", false);

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("orb inspection HTTP endpoint", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("authenticates and validates the orb list", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer runtime-secret" });
      return response(200, { v: 1, currentOrbId: "orb-a", items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new HttpOrbInspectionEndpoint(env).list(task);
    expect(result).toEqual({ kind: "list", value: { v: 1, currentOrbId: "orb-a", items: [] } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://runtime.example/runtime/v1/orbs",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("consumes a large chunked transcript through real HTTP before the existing deadline", async () => {
    const app = Fastify({ logger: false });
    const text = "x".repeat(33 * 1024 * 1024);
    const metadata = {
      v: 1,
      orb: {
        id: "orb-b",
        name: null,
        state: "stopped",
        updatedAt: "2026-08-27T00:00:00.000Z",
        project: { id: "project", name: "Project", repositoryUrl: "https://example.com" },
      },
      session: null,
      cursor: "record",
      headId: "record",
    };
    app.get("/runtime/v1/orbs/orb-b/transcript", (_request, reply) => {
      reply.header("content-type", "application/json");
      return reply.send(
        Readable.from([
          `${JSON.stringify(metadata).slice(0, -1)},"records":[`,
          JSON.stringify({
            id: "record",
            parentId: null,
            timestamp: "2026-08-27T00:00:00.000Z",
            type: "message",
            role: "user",
            overflow: {},
            content: [{ type: "text", text }],
          }),
          "]}",
        ]),
      );
    });
    try {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("missing test listener");
      const result = await new HttpOrbInspectionEndpoint({
        ...env,
        controlPlaneUrl: `http://127.0.0.1:${address.port}`,
      }).transcript(task, "orb-b");
      expect(result.kind).toBe("transcript");
      if (result.kind === "transcript") {
        const record = result.value.records[0];
        expect(record?.type).toBe("message");
        if (record?.type === "message") expect(record.content).toEqual([{ type: "text", text }]);
        expect(Buffer.byteLength(JSON.stringify(result.value))).toBeGreaterThan(32 * 1024 * 1024);
      }
    } finally {
      await app.close();
    }
  });

  it("encodes a transcript orb id as one path segment", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(
        "https://runtime.example/runtime/v1/orbs/orb%20with%2Fslash/transcript",
      );
      return response(404, {
        v: 1,
        error: { code: "not_found", message: "orb not found", retryable: false },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await new HttpOrbInspectionEndpoint(env).transcript(task, "orb with/slash")).toEqual({
      kind: "not_found",
      message: "orb not found",
    });
  });

  it("treats malformed success as an internal control-plane failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(200, { items: [] })),
    );
    expect(await new HttpOrbInspectionEndpoint(env).list(task)).toEqual({
      kind: "internal",
      message: "malformed orb list response",
    });
  });

  it("maps authorization and retryable failures without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(401, { error: "unauthorized" })),
    );
    expect(await new HttpOrbInspectionEndpoint(env).list(task)).toEqual({ kind: "unauthorized" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("network down"))),
    );
    expect(await new HttpOrbInspectionEndpoint(env).list(task)).toEqual({
      kind: "unavailable",
      message: "network down",
    });
  });

  it("bounds a silent request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    const pending = new HttpOrbInspectionEndpoint(env).list(task);
    await vi.advanceTimersByTimeAsync(INSPECTION_REQUEST_TIMEOUT_MS);
    expect(await pending).toEqual({
      kind: "unavailable",
      message: `control plane did not answer within ${INSPECTION_REQUEST_TIMEOUT_MS}ms`,
    });
    vi.useRealTimers();
  });
});
