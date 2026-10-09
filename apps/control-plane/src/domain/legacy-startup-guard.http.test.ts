import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { SdkAgentPlane } from "../adapters/sdk-agent-plane.ts";
import { registerAuthenticatedBrowserRoutes } from "../http/browser-identity.ts";
import { registerRoutes } from "../http/routes.ts";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  TEST_SYSTEM_VIEW,
  TEST_USER_ID,
} from "../testkit/fixtures.ts";
import type { AgentPlane } from "./agent-ports.ts";
import type { RuntimeClientError } from "./errors.ts";
import { HarnessAgentPlane } from "./harness-agent-plane.ts";

const message = "This orb uses the old Pi backend. Create a new orb to continue.";
const task = new NoSimulationTask("legacy startup HTTP", false);
const url = "/api/v1/orbs/orb/start";
type StartupCheck = AgentPlane["health"] extends (...args: infer Args) => unknown
  ? (...args: Args) => ReturnType<AgentPlane["suspend"]>
  : never;

function setup(
  options: {
    state?: "stopped" | "failed" | "creating" | "starting" | "running";
    legacy?: boolean;
    harness?: "pi" | "claude";
    placement?: "central" | "host";
  } = {},
) {
  const h = makeHarness();
  h.store.seedProject(makeProjectRow("project"));
  h.store.seedOrb(
    makeOrbRow("orb", "project", options.state ?? "stopped", {
      harness: options.harness ?? "pi",
      ...(options.legacy === false
        ? {}
        : {
            harnessSessionId: "old-pi-session",
            harnessSessionHeader: { id: "old-pi-session", overflow: {} },
          }),
    }),
  );
  const host = new SdkAgentPlane(h.deps);
  const selected = new SdkAgentPlane(h.deps);
  Object.defineProperty(selected, "placement", { value: options.placement ?? "central" });
  const checkStartup = vi.fn<StartupCheck>((_task, orb, context) => {
    expect(context.signal.aborted).toBe(false);
    if (orb.harnessSessionId === null) return okAsync(undefined);
    // The agreed port code is intentionally injected before its union is implemented.
    return errAsync({
      type: "runtime_client_error",
      code: "legacy_backend",
      answered: true,
      retryable: false,
      message,
    } as unknown as RuntimeClientError);
  });
  const pi: AgentPlane & { checkStartup: StartupCheck } = Object.assign(selected, { checkStartup });
  const plane = new HarnessAgentPlane(pi, host, h.store);
  const cas = vi.spyOn(h.store, "casTransition");
  const cancelSleep = vi.spyOn(h.store, "cancelOrbSleep");
  const provision = vi.spyOn(h.deps.hostProvider, "provision");
  const health = vi.spyOn(selected, "health");
  const app = Fastify();
  registerAuthenticatedBrowserRoutes(
    app,
    (request) =>
      request.headers.authorization === "Bearer fixture-owner"
        ? okAsync({ kind: "user" as const, user: { id: TEST_USER_ID, email: null } })
        : errAsync({ type: "unauthenticated" as const, message: "Authentication required" }),
    (browser) =>
      registerRoutes(browser, task, { ...h.deps, agentPlane: plane }, {}, TEST_SYSTEM_VIEW),
  );
  return { h, app, checkStartup, cas, cancelSleep, provision, health };
}
const headers = { authorization: "Bearer fixture-owner" };

it.each(["stopped", "failed", "creating", "starting", "running"] as const)(
  "authenticated Start rejects legacy %s without changing authority or compute",
  async (state) => {
    const f = setup({ state });
    const before = f.h.store.orbSnapshot("orb");
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await f.app.inject({ method: "POST", url, headers });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: { code: "conflict", message, retryable: false } });
        expect(response.headers.location).toBeUndefined();
      }
      expect(f.checkStartup).toHaveBeenCalled();
      expect(f.h.store.orbSnapshot("orb")).toEqual(before);
      expect(f.h.store.messageSnapshots("orb")).toEqual([]);
      expect(f.h.store.replicaRecords("orb")).toEqual([]);
      expect(f.cas).not.toHaveBeenCalled();
      expect(f.cancelSleep).not.toHaveBeenCalled();
      expect(f.provision).not.toHaveBeenCalled();
      expect(f.health).not.toHaveBeenCalled();
      const retained = await f.app.inject({ method: "GET", url: "/api/v1/orbs/orb", headers });
      expect(retained.statusCode).toBe(200);
      expect(retained.json().id).toBe("orb");
    } finally {
      await f.app.close();
    }
  },
);

it("authenticates before consulting startup compatibility", async () => {
  const f = setup();
  try {
    const response = await f.app.inject({ method: "POST", url });
    expect(response.statusCode).toBe(401);
    expect(f.checkStartup).not.toHaveBeenCalled();
    expect(f.cas).not.toHaveBeenCalled();
  } finally {
    await f.app.close();
  }
});

it("fresh central Pi Start keeps the existing accepted transition", async () => {
  const f = setup({ legacy: false });
  try {
    const response = await f.app.inject({ method: "POST", url, headers });
    expect(response.statusCode).toBe(202);
    expect(f.checkStartup).toHaveBeenCalledTimes(1);
    expect(f.h.store.orbSnapshot("orb")?.state).toBe("starting");
    expect(f.cas).toHaveBeenCalledTimes(1);
    expect(f.provision).not.toHaveBeenCalled();
  } finally {
    await f.app.close();
  }
});

it.each([
  { harness: "claude" as const, placement: "central" as const },
  { harness: "pi" as const, placement: "host" as const },
])("$harness with Pi $placement bypasses central preflight", async (options) => {
  const f = setup(options);
  try {
    const response = await f.app.inject({ method: "POST", url, headers });
    expect(response.statusCode).toBe(202);
    expect(f.checkStartup).not.toHaveBeenCalled();
    expect(f.h.store.orbSnapshot("orb")?.state).toBe("starting");
  } finally {
    await f.app.close();
  }
});
