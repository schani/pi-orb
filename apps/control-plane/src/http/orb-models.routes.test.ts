import { OrbModelOptionsResponseSchema, OrbViewSchema } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, okAsync } from "neverthrow";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIFECYCLE_LOG_PREFIX } from "../domain/log.ts";
import type { ListOrbModelOptions } from "../domain/orb-models.ts";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { registerAuthenticatedBrowserRoutes } from "./browser-identity.ts";
import { registerRoutes } from "./routes.ts";

const task = new NoSimulationTask("offline model routes", false);
const orbId = "00000000-0000-4000-8000-0000000000c1";
const base = `/api/v1/orbs/${orbId}`;
const project = makeProjectRow("project");
const piModel = { provider: "openai-codex", id: "gpt-6.2-sol" };
const claudeModel = { provider: "claude", id: "opus" };

describe("offline model browser routes", () => {
  let app: ReturnType<typeof Fastify>;
  function setup({
    harness = "pi",
    state = "stopped",
    authenticated = true,
  }: {
    harness?: "pi" | "claude";
    state?: Parameters<typeof makeOrbRow>[2];
    authenticated?: boolean;
  } = {}) {
    const h = makeHarness();
    h.store.seedProject(project);
    h.store.seedOrb(
      makeOrbRow(orbId, project.id, state, {
        harness,
        stateVersion: 5,
        stopReason: "manual",
        lastReadyAt: 10,
      }),
    );
    const model = harness === "pi" ? piModel : claudeModel;
    const option = { ...model, name: harness === "pi" ? "Sol" : "Opus" };
    const listOrbModelOptions = vi.fn<ListOrbModelOptions>(() => okAsync([option]));
    const startHost = vi.spyOn(h.deps.hostProvider, "start");
    const log = vi.spyOn(task, "log").mockImplementation(() => {});
    const lifecycleLogs = () =>
      log.mock.calls.flatMap(([line]) =>
        typeof line === "string" && line.startsWith(LIFECYCLE_LOG_PREFIX) ? [line] : [],
      );
    app = Fastify();
    registerAuthenticatedBrowserRoutes(
      app,
      () =>
        authenticated
          ? okAsync({ kind: "user", user: { id: "coworker", email: null } })
          : errAsync({ type: "unauthenticated", message: "sign in" }),
      (scope) => registerRoutes(scope, task, { ...h.deps, listOrbModelOptions }, TEST_SYSTEM_VIEW),
    );
    return { ...h, model, option, listOrbModelOptions, startHost, lifecycleLogs };
  }

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it.each(["pi", "claude"] as const)(
    "lets a coworker list and queue %s settings with the owner's catalog, without waking the orb",
    async (harness) => {
      const h = setup({ harness });
      const before = await app.inject({ method: "GET", url: base });
      expect(before.json()).toMatchObject({ canQueueModel: true, pendingModel: null });
      const list = await app.inject({
        method: "GET",
        url: `${base}/model-options`,
        headers: { "x-pi-orb-user-id": "not-the-owner" },
      });
      expect(list.statusCode).toBe(200);
      expect(list.headers["cache-control"]).toContain("no-store");
      expect(Check(OrbModelOptionsResponseSchema, list.json())).toBe(true);
      expect(list.json()).toEqual({ models: [h.option] });
      expect(h.lifecycleLogs()).toEqual([]);
      const first = await app.inject({
        method: "PUT",
        url: `${base}/pending-model`,
        payload: { model: h.model },
      });
      expect(first.statusCode).toBe(200);
      expect(Check(OrbViewSchema, first.json())).toBe(true);
      expect(first.json()).toMatchObject({
        state: "stopped",
        stateVersion: 5,
        stopReason: "manual",
        canQueueModel: true,
        pendingModel: { changeId: expect.any(String), model: h.model },
      });
      const replacement = { ...h.model, id: harness === "pi" ? "gpt-6.2-astra" : "sonnet" };
      h.listOrbModelOptions.mockReturnValueOnce(okAsync([{ ...replacement, name: "Replacement" }]));
      const second = await app.inject({
        method: "PUT",
        url: `${base}/pending-model`,
        payload: { model: replacement },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().pendingModel.model).toEqual(replacement);
      expect(second.json().pendingModel.changeId).not.toBe(first.json().pendingModel.changeId);
      expect((await app.inject({ method: "GET", url: base })).json().pendingModel).toEqual(
        second.json().pendingModel,
      );
      expect(h.listOrbModelOptions.mock.calls).toEqual(
        Array.from({ length: 3 }, () => [task, project.ownerUserId, harness]),
      );
      expect(h.startHost).not.toHaveBeenCalled();
    },
  );

  it("rejects unauthenticated callers before catalog access or persistence", async () => {
    const h = setup({ authenticated: false });
    const read = vi.spyOn(h.store, "getOrb");
    expect((await app.inject({ method: "GET", url: `${base}/model-options` })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `${base}/pending-model`,
          payload: { model: piModel },
        })
      ).statusCode,
    ).toBe(401);
    expect(read).not.toHaveBeenCalled();
    expect(h.lifecycleLogs()).toEqual([]);
    expect(h.listOrbModelOptions).not.toHaveBeenCalled();
  });

  it.each([
    [{}, false],
    [{ model: { ...piModel, id: "" } }, false],
    [{ model: { ...piModel, thinking: "high" } }, false],
    [{ model: piModel, changeId: "client-supplied" }, false],
    [{ model: claudeModel }, false],
    [{ model: { ...piModel, id: "PRIVATE_MODEL_ID\nforged=true" } }, true],
  ] as const)("rejects invalid selection %o", async (payload, checksCatalog) => {
    const h = setup();
    const response = await app.inject({ method: "PUT", url: `${base}/pending-model`, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: "invalid_request", retryable: false });
    expect(h.listOrbModelOptions).toHaveBeenCalledTimes(checksCatalog ? 1 : 0);
    expect(h.store.orbSnapshot(orbId)?.pendingModel ?? null).toBeNull();
    expect(h.lifecycleLogs()).toEqual([
      `lifecycle: orb=${orbId} offline-model-failed op=pending-model code=invalid_request`,
    ]);
  });

  it("refuses an ineligible orb without looking up models", async () => {
    const h = setup({ state: "running" });
    expect((await app.inject({ method: "GET", url: base })).json().canQueueModel).toBe(false);
    expect((await app.inject({ method: "GET", url: `${base}/model-options` })).statusCode).toBe(
      409,
    );
    const response = await app.inject({
      method: "PUT",
      url: `${base}/pending-model`,
      payload: { model: piModel },
    });
    expect(response.statusCode).toBe(409);
    expect(h.listOrbModelOptions).not.toHaveBeenCalled();
    expect(h.lifecycleLogs()).toEqual([
      `lifecycle: orb=${orbId} offline-model-failed op=model-options code=conflict`,
      `lifecycle: orb=${orbId} offline-model-failed op=pending-model code=conflict`,
    ]);
  });

  it("returns not found without logging an invalid orb path segment", async () => {
    const h = setup();
    const url = "/api/v1/orbs/PRIVATE_PATH_VALUE%0Aforged%3Dtrue";
    expect((await app.inject({ method: "GET", url: `${url}/model-options` })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `${url}/pending-model`,
          payload: { model: piModel },
        })
      ).statusCode,
    ).toBe(404);
    expect(h.listOrbModelOptions).not.toHaveBeenCalled();
    expect(h.lifecycleLogs()).toEqual([
      "lifecycle: orb=invalid offline-model-failed op=model-options code=not_found",
      "lifecycle: orb=invalid offline-model-failed op=pending-model code=not_found",
    ]);
  });

  it.each([
    { reason: "disconnected", status: 409, code: "conflict", retryable: false },
    { reason: "unavailable", status: 503, code: "unavailable", retryable: true },
    { reason: "probe_timeout", status: 503, code: "unavailable", retryable: true },
    { reason: "probe_failed", status: 503, code: "unavailable", retryable: true },
    { reason: "cleanup_failed", status: 503, code: "unavailable", retryable: true },
  ] as const)("reports a $reason owner catalog without queueing", async (failure) => {
    const h = setup();
    h.listOrbModelOptions.mockReturnValue(
      errAsync({ type: "model_catalog_error", reason: failure.reason }),
    );
    const list = await app.inject({ method: "GET", url: `${base}/model-options` });
    const put = await app.inject({
      method: "PUT",
      url: `${base}/pending-model`,
      payload: { model: piModel },
    });
    for (const response of [list, put]) {
      expect(response.statusCode).toBe(failure.status);
      expect(response.json().error).toMatchObject({
        code: failure.code,
        retryable: failure.retryable,
      });
    }
    expect(h.store.orbSnapshot(orbId)?.pendingModel).toBeNull();
    expect(h.lifecycleLogs()).toEqual([
      `lifecycle: orb=${orbId} offline-model-failed op=model-options reason=${failure.reason}`,
      `lifecycle: orb=${orbId} offline-model-failed op=pending-model reason=${failure.reason}`,
    ]);
  });

  it("does not expose raw store diagnostics from catalog lookup", async () => {
    const h = setup();
    vi.spyOn(h.store, "getProject").mockReturnValueOnce(
      errAsync({
        type: "store_error",
        code: "invariant",
        message: "PRIVATE_SQL_DIAGNOSTIC",
        retryable: false,
      }),
    );
    const response = await app.inject({ method: "GET", url: `${base}/model-options` });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toMatchObject({ code: "internal", retryable: false });
    expect(response.body).not.toContain("PRIVATE_SQL_DIAGNOSTIC");
    expect(h.lifecycleLogs()).toEqual([
      `lifecycle: orb=${orbId} offline-model-failed op=model-options code=invariant`,
    ]);
    expect(h.listOrbModelOptions).not.toHaveBeenCalled();
  });

  it("returns conflict when the store fence loses after catalog validation", async () => {
    const h = setup();
    vi.spyOn(h.store, "queueModel").mockReturnValueOnce(okAsync(false));
    const response = await app.inject({
      method: "PUT",
      url: `${base}/pending-model`,
      payload: { model: piModel },
    });
    expect(h.listOrbModelOptions).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "conflict", retryable: false });
    expect(h.lifecycleLogs()).toEqual([
      `lifecycle: orb=${orbId} offline-model-failed op=pending-model code=conflict`,
    ]);
  });
});
