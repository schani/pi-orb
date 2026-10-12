import type { IncomingMessage, ServerResponse } from "node:http";
import type { DisplayHistoryView, OrbView } from "@pi-orb/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Connect, ViteDevServer } from "vite";
import { afterEach, expect, it, vi } from "vitest";
import { mockBackendPlugin } from "../../dev/mock-backend.ts";
import { type PersistedToolCall, ToolActivity } from "../components/ToolActivity.tsx";
import { detailContext } from "./display-fixtures.ts";

const projectPath = "/api/v1/projects/frontend-fixture-project/orbs";
const rotatingIds = ["frontend-fixture-orb", "frontend-long-history", "frontend-lazy-details"];

function fixture(timestampChurn = false) {
  let middleware: Connect.NextHandleFunction | undefined;
  const plugin = mockBackendPlugin({ timestampChurn });
  const configure = plugin.configureServer;
  if (typeof configure !== "function") return expect.fail("missing fixture server hook");
  configure.call(
    {} as never,
    {
      middlewares: {
        use(handler: Connect.NextHandleFunction) {
          middleware = handler;
        },
      },
    } as unknown as ViteDevServer,
  );
  return async <T>(path: string): Promise<T> =>
    new Promise((resolve) => {
      const response = {
        statusCode: 0,
        setHeader() {},
        end(body: string) {
          expect(response.statusCode).toBe(200);
          resolve(JSON.parse(body) as T);
        },
      };
      if (middleware === undefined) return expect.fail("missing fixture middleware");
      middleware(
        { method: "GET", url: path, headers: {} } as IncomingMessage,
        response as unknown as ServerResponse,
        () => expect.fail("fixture request was not handled"),
      );
    });
}

afterEach(() => vi.useRealTimers());

it("seeds completed, failed and unresolved codemode calls in one group", async () => {
  const get = fixture();
  const { items } = await get<{ items: OrbView[] }>(projectPath);
  expect(items.find((orb) => orb.id === "frontend-mixed-tool-states")?.name).toBe(
    "Mixed tool states",
  );
  const history = await get<DisplayHistoryView>("/api/v1/orbs/frontend-mixed-tool-states/history");
  const blocks = history.records.flatMap((record) =>
    record.type === "message" ? record.content : [],
  );
  const calls = blocks.filter((block) => block.type === "tool_call");
  const results = blocks.filter((block) => block.type === "tool_result");
  expect(calls.map((call) => call.name)).toEqual(["codemode", "codemode", "codemode"]);
  expect([...calls, ...results].every((block) => block.headline === undefined)).toBe(true);
  expect(results.map((result) => result.isError === true)).toEqual([false, true]);
  expect(calls.map((call) => call.callId)).toEqual([
    "mixed-completed",
    "mixed-failed",
    "mixed-running",
  ]);
  expect(results.map((result) => result.callId)).toEqual(["mixed-completed", "mixed-failed"]);
  expect(results.every((result) => !result.hasImages)).toBe(true);
  expect(results.some((result) => result.callId === calls[2]?.callId)).toBe(false);

  const persisted: PersistedToolCall[] = history.records.flatMap((record) =>
    record.type === "message"
      ? record.content.flatMap((call) => {
          if (call.type !== "tool_call") return [];
          const owner = history.records.find(
            (candidate) =>
              candidate.type === "message" &&
              candidate.content.some(
                (block) => block.type === "tool_result" && block.callId === call.callId,
              ),
          );
          const result = results.find((entry) => entry.callId === call.callId);
          return [
            {
              call,
              callRecordId: record.id,
              ...(owner && result
                ? {
                    result,
                    resultRecordId: owner.id,
                  }
                : {}),
            },
          ];
        })
      : [],
  );
  const html = renderToStaticMarkup(
    createElement(ToolActivity, { persisted, detailContext: detailContext() }),
  );
  expect(html.match(/class="activity-rail-row [^"]*tool-activity-category"/g)).toHaveLength(1);
  expect(html).toContain("3 calls");
  expect(html).toContain("1 failed");
  for (const state of ["completed", "failed", "running"]) {
    expect(
      html.match(new RegExp(`class="tool-activity-call tool-call-${state}"`, "g")),
    ).toHaveLength(1);
  }
});

it("leaves timestamps unchanged in the default frontend fixture", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-05T12:00:00Z");
  const get = fixture();
  const first = await get<{ items: OrbView[] }>(projectPath);
  vi.advanceTimersByTime(2_000);
  expect(await get(projectPath)).toEqual(first);
});

it("rotates real orb updates each list poll only when opted in", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-05T12:00:00Z");
  const get = fixture(true);
  let previous = await get<{ items: OrbView[] }>(projectPath);
  const newestIds: string[] = [];
  for (let poll = 1; poll <= rotatingIds.length; poll += 1) {
    vi.advanceTimersByTime(2_000);
    const current = await get<{ items: OrbView[] }>(projectPath);
    const changed = current.items.filter(
      (orb) => orb.updatedAt !== previous.items.find((old) => old.id === orb.id)?.updatedAt,
    );
    const expectedId = rotatingIds[poll % rotatingIds.length];
    expect(changed.map((orb) => orb.id)).toEqual([expectedId]);
    expect(changed[0]?.updatedAt).toBe(new Date().toISOString());
    expect(current.items.map(({ updatedAt: _, ...orb }) => orb)).toEqual(
      previous.items.map(({ updatedAt: _, ...orb }) => orb),
    );
    const newest = [...current.items].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )[0];
    expect(newest?.id).toBe(expectedId);
    newestIds.push(newest?.id ?? "");
    expect(await get<OrbView>(`/api/v1/orbs/${expectedId}`)).toEqual(changed[0]);
    const otherProjectPath = "/api/v1/projects/frontend-fieldnotes-project/orbs";
    const otherProject = await get(otherProjectPath);
    vi.advanceTimersByTime(2_000);
    expect(await get(otherProjectPath)).toEqual(otherProject);
    previous = current;
  }
  expect(new Set(newestIds).size).toBe(rotatingIds.length);
});
