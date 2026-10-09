import type { DisplayHistoryView, HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { hasCommittedMcpStatus } from "../../../e2e/testkit/mcp-status-detail.ts";
import { registerRoutes } from "./http/routes.ts";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  TEST_SYSTEM_VIEW,
  TEST_USER_ID,
} from "./testkit/fixtures.ts";

it.each(["needs-auth", "connected"] as const)(
  "reads committed MCP %s from public display details",
  async (status) => {
    const task = new NoSimulationTask("MCP display detail", false);
    const h = makeHarness();
    h.store.seedProject(makeProjectRow("project"));
    h.store.seedOrb({ ...makeOrbRow("orb", "project", "stopped"), harnessSessionId: "session" });
    const record: HistoryRecord = {
      id: "tool/record",
      parentId: null,
      timestamp: "2026-10-06T00:00:00.000Z",
      overflow: {},
      type: "message",
      role: "tool",
      content: [
        {
          type: "tool_result",
          callId: "call",
          content: [{ type: "text", text: `MCP fixture: ${status}.` }],
        },
      ],
    };
    (
      await h.store.commitPullBatch(task, {
        orbId: "orb",
        expectedCursor: null,
        session: { id: "session", overflow: {} },
        records: [record],
        nextCursor: record.id,
        nextHeadId: record.id,
      })
    )._unsafeUnwrap();
    const app = Fastify({ logger: false });
    app.addHook("onRequest", async (request) => {
      request.principal = { kind: "user", user: { id: TEST_USER_ID, email: null } };
    });
    registerRoutes(app, task, h.deps, {}, TEST_SYSTEM_VIEW);
    const paths: string[] = [];
    const request = async (path: string) => {
      paths.push(path);
      const response = await app.inject({ method: "GET", url: path });
      return { status: response.statusCode, body: response.json() as Record<string, unknown> };
    };
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/orbs/orb/history" });
      expect(response.statusCode).toBe(200);
      const history = response.json() as DisplayHistoryView;
      expect(JSON.stringify(history)).not.toContain(`MCP fixture: ${status}.`);
      expect((await hasCommittedMcpStatus(history, status, request))._unsafeUnwrap()).toBe(true);
      expect(paths).toEqual([
        "/api/v1/orbs/orb/details/tool%2Frecord/tool%2Frecord%3A0?sessionId=session",
      ]);
      expect(
        (
          await hasCommittedMcpStatus(
            history,
            status === "connected" ? "needs-auth" : "connected",
            request,
          )
        )._unsafeUnwrap(),
      ).toBe(false);
      const pending = vi.spyOn(h.store, "readHistoryRecord").mockReturnValueOnce(
        errAsync({
          type: "store_error",
          code: "unavailable",
          retryable: true,
          message: "PRIVATE",
        }),
      );
      expect(await hasCommittedMcpStatus(history, status, request)).toMatchObject({
        error: { type: "detail_unavailable", status: 503 },
      });
      pending.mockReturnValueOnce(okAsync(null));
      expect(await hasCommittedMcpStatus(history, status, request)).toMatchObject({
        error: { type: "detail_missing", status: 404 },
      });
      pending.mockRestore();
    } finally {
      await app.close();
    }
  },
);
