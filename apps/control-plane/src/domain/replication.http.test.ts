import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { HistoryRecord } from "@pi-orb/protocol";
import { type Deadline, NoSimulationTask } from "determined";
import { assert, describe, expect, it, vi } from "vitest";
import { FetchRuntimeClient } from "../adapters/runtime-client/fetch-client.ts";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import { LogCapture } from "../testkit/sim.ts";
import type { RuntimeClientError } from "./errors.ts";
import { pollOrbUntilCaughtUp } from "./replication.ts";

const ORB = "orb-a";
const PRIVATE = "PRIVATE_SENTINEL";
const session = { id: "native-session", overflow: {} };
const record: HistoryRecord = {
  id: "committed-record",
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  type: "event",
  eventType: "claude.operation_finished",
  content: [],
  overflow: {},
};

class PullTask extends NoSimulationTask {
  readonly logs = new LogCapture();
  readonly deadlines: { reason: string; controller: AbortController; cancelled: boolean }[] = [];

  constructor() {
    super("replication-http", false);
  }

  override wallNow() {
    return 1_767_225_600_000;
  }

  override log(...parts: readonly unknown[]) {
    this.logs.log(...parts);
  }

  override createDeadline(_durationMs: number, reason: string): Deadline {
    const entry = { reason, controller: new AbortController(), cancelled: false };
    this.deadlines.push(entry);
    return {
      signal: entry.controller.signal,
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }
}

async function fixture(status: number, body: string, held = false) {
  const task = new PullTask();
  const h = makeHarness();
  seedRunningOrb(task, h, ORB);
  const seeded = h.store.orbSnapshot(ORB);
  assert(seeded !== null);
  h.store.seedOrb({ ...seeded, harness: "claude", stateVersion: 11 });
  expect(
    (
      await h.store.commitPullBatch(task, {
        orbId: ORB,
        expectedCursor: null,
        session,
        records: [record],
        nextCursor: record.id,
        nextHeadId: record.id,
      })
    ).isOk(),
  ).toBe(true);
  const before = h.store.orbSnapshot(ORB);
  assert(before !== null);
  expect(before.runtimeTokenHash).not.toBeNull();

  const requests: string[] = [];
  let response: ServerResponse | undefined;
  const server = createServer((request, reply) => {
    const url = new URL(request.url ?? "/", "http://loopback");
    requests.push(url.pathname);
    reply.setHeader("content-type", "application/json");
    if (url.pathname === "/v1/health") {
      reply.end(
        JSON.stringify({
          v: 1,
          orbId: ORB,
          runtimeInstanceId: "native-runtime",
          status: "ready",
          sessionId: session.id,
          checkoutCommit: "commit-0",
          activity: "idle",
        }),
      );
      return;
    }
    expect(url.pathname).toBe("/v1/history");
    expect(url.searchParams.get("after")).toBe(before.replicationCursor);
    reply.statusCode = status;
    response = reply;
    if (held) {
      reply.write(body);
      reply.flushHeaders();
    } else {
      reply.end(body);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Observe real body consumption, not merely server-side header emission.
  let bodyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  const fetch = globalThis.fetch;
  const fetchSpy = held
    ? vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
        const result = await fetch(...args);
        if (String(args[0]).startsWith(`${baseUrl}/v1/history?`)) {
          for (const method of ["json", "text"] as const) {
            const consume = result[method].bind(result);
            vi.spyOn(result, method).mockImplementation(() => {
              const pending = consume();
              bodyStarted();
              return pending;
            });
          }
        }
        return result;
      })
    : undefined;

  const client = new FetchRuntimeClient();
  const errors: RuntimeClientError[] = [];
  const pull = client.pullHistory.bind(client);
  vi.spyOn(client, "pullHistory").mockImplementation((...args) =>
    pull(...args).mapErr((error) => {
      errors.push(error);
      return error;
    }),
  );
  const provider = h.deps.hostProvider;
  const deps = {
    ...h.deps,
    runtimeClient: client,
    hostProvider: new Proxy(provider, {
      get(target, key) {
        if (key === "observe")
          return (...args: Parameters<typeof provider.observe>) =>
            provider.observe(...args).map((observation) =>
              observation === null
                ? null
                : {
                    ...observation,
                    runtimeAddress: { baseUrl },
                  },
            );
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };

  return {
    task,
    h,
    before,
    deps,
    requests,
    errors,
    bodyStarted: started,
    interrupt: () => {
      assert(response !== undefined);
      response.destroy();
    },
    close: async () => {
      fetchSpy?.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe("runtime pull transport and replication authority (HTTP)", () => {
  it.each(["deadline", "socket", "503"] as const)(
    "%s retains committed authority and returns retryable",
    async (scenario) => {
      const f = await fixture(
        scenario === "503" ? 503 : 200,
        scenario === "503" ? "upstream unavailable" : "{",
        scenario !== "503",
      );
      try {
        const polling = pollOrbUntilCaughtUp(f.task, f.deps, ORB, 1);
        if (scenario !== "503") {
          await f.bodyStarted;
          const deadline = f.task.deadlines.find(
            (entry) => entry.reason === "history pull request",
          );
          assert(deadline !== undefined);
          expect(deadline.controller.signal.aborted).toBe(false);
          expect(deadline.cancelled).toBe(false);
          expect(f.h.store.orbSnapshot(ORB)).toEqual(f.before);
          if (scenario === "deadline") deadline.controller.abort();
          else f.interrupt();
        }
        const outcome = await polling;
        expect.soft(outcome.type).toBe("retryable");
        expect.soft(f.errors).toEqual([
          expect.objectContaining({
            type: "runtime_client_error",
            code:
              scenario === "deadline"
                ? "cancelled"
                : scenario === "socket"
                  ? "unreachable"
                  : "http_error",
            retryable: true,
          }),
        ]);
        // The whole row pins cursor/head, version, bearer and every discard field.
        expect.soft(f.h.store.orbSnapshot(ORB)).toEqual(f.before);
        expect.soft(f.h.store.replicaRecords(ORB)).toEqual([record]);
        expect.soft(f.task.logs.lines()).toEqual([]);
        expect(f.requests[0]).toBe("/v1/history");
        expect(f.task.deadlines.every((entry) => entry.cancelled)).toBe(true);
      } finally {
        await f.close();
      }
    },
  );

  it.each(["syntax", "schema"] as const)(
    "malformed successful %s commits failure/discard authority without losing the cursor",
    async (kind) => {
      const f = await fixture(
        200,
        kind === "syntax" ? `${PRIVATE}{` : JSON.stringify({ private: PRIVATE }),
      );
      try {
        expect(await pollOrbUntilCaughtUp(f.task, f.deps, ORB, 1)).toEqual({
          type: "integrity",
          reason: "mapping_failure",
        });
        expect(f.errors).toEqual([
          expect.objectContaining({
            type: "runtime_client_error",
            code: "invalid_response",
            retryable: false,
            answered: true,
          }),
        ]);
        const after = f.h.store.orbSnapshot(ORB);
        assert(after !== null);
        expect(after).toEqual({
          ...f.before,
          state: "failed",
          stateVersion: f.before.stateVersion + 1,
          stateChangedAt: f.task.wallNow(),
          updatedAt: f.task.wallNow(),
          lastError: expect.stringContaining("replication_integrity"),
          runtimeTokenHash: null,
          hostDiscardThroughIncarnation: f.before.hostIncarnation,
          hostDiscardReason: "failed",
          hostDiscardRequestedAt: f.task.wallNow(),
          hostDiscardError: null,
          hostDiscardEvidence: null,
        });
        expect(after.lastError).toContain("mapping_failure");
        expect(f.h.store.replicaRecords(ORB)).toEqual([record]);
        expect(f.requests).toEqual(["/v1/history", "/v1/health"]);
        expect(f.task.logs.matching("transition")).toEqual([
          expect.stringContaining(
            "from=running to=failed code=replication_integrity reason=mapping_failure",
          ),
        ]);
        expect(f.task.logs.matching("compute-discard-requested")).toEqual([
          expect.stringContaining(
            `host=${f.before.hostRef} through_incarnation=${f.before.hostIncarnation} reason=failed failure_code=replication_integrity`,
          ),
        ]);
        expect(f.task.logs.lines()).toHaveLength(2);
        expect(f.task.deadlines.every((entry) => entry.cancelled)).toBe(true);
      } finally {
        await f.close();
      }
    },
  );

  it("syntax failure keeps response content out of persisted errors and lifecycle events", async () => {
    const f = await fixture(200, `${PRIVATE}{`);
    try {
      expect((await pollOrbUntilCaughtUp(f.task, f.deps, ORB, 1)).type).toBe("integrity");
      const after = f.h.store.orbSnapshot(ORB);
      assert(after !== null);
      expect.soft(after.lastError).not.toContain(PRIVATE);
      expect.soft(f.task.logs.lines().join("\n")).not.toContain(PRIVATE);
    } finally {
      await f.close();
    }
  });
});
