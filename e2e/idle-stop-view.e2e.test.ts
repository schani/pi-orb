import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_SUBPROTOCOL, type ServerFrame } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import WebSocket from "ws";
import { DEFAULT_LIFECYCLE_CONSTANTS } from "../apps/control-plane/src/domain/constants.ts";
import {
  api,
  type ControlPlaneHandle,
  createFakeSession,
  deleteFakeSession,
  type FakeSession,
  FatalProbeError,
  fakeControl,
  forceReconcilePass,
  startControlPlane,
  waitFor,
} from "./harness.ts";

const stop = { type: "stop", status: "completed" } as const;
const PORT = 7187;

it("viewing an idle-stopped orb leaves it stopped; sending a message starts it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-idle-view-e2e-"));
  const projectId = randomUUID();
  const orbId = randomUUID();
  let fake: FakeSession | undefined;
  let nameFake: FakeSession | undefined;
  let cp: ControlPlaneHandle | undefined;
  let socket: WebSocket | undefined;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    fake = await createFakeSession(`idle-view-${randomUUID()}`, {
      auth: { accountId: "idle-view-test", device: { manualApprove: true } },
      model: {
        rules: [
          {
            match: { userMessage: { regex: "^wake on send$" } },
            steps: [{ type: "text", content: "IDLE_VIEW_REPLY" }, stop],
          },
          { match: { default: true }, steps: [{ type: "text", content: "Idle view." }, stop] },
        ],
      },
    });
    nameFake = await createFakeSession(`idle-view-names-${randomUUID()}`, {
      auth: { accountId: "acct_pi_orb_e2e" },
      model: {
        rules: [{ match: { default: true }, steps: [{ type: "text", content: "Idle" }, stop] }],
      },
    });
    cp = await startControlPlane({
      port: PORT,
      fake,
      nameFake,
      pglitePath: join(root, "db"),
      processStateDirectory: join(root, "hosts"),
      authDir: join(root, "auth"),
      hostingRoot: join(root, "hosting"),
      controlledClockEpoch: Date.now(),
      extraEnv: { PI_ORB_E2E_RECONCILE_CHECKPOINTS: "1" },
    });
    const activeCp = cp;
    const clock = activeCp.clock;
    if (clock === undefined) throw new Error("controlled clock was not attached");
    const view = async () => (await api(activeCp.baseUrl, "GET", `/api/v1/orbs/${orbId}`)).body;

    expect(
      (
        await api(cp.baseUrl, "POST", "/api/v1/projects", {
          id: projectId,
          name: "Idle view E2E",
          repositoryUrl: "https://github.com/schani/pi-orb",
        })
      ).status,
    ).toBe(201);
    expect(
      (await api(cp.baseUrl, "POST", `/api/v1/projects/${projectId}/orbs`, { id: orbId })).status,
    ).toBe(202);
    const code = await waitFor("idle view fixture login", async () => {
      const action = (await view())["actionRequired"] as { userCode?: unknown } | undefined;
      return typeof action?.userCode === "string" && action.userCode !== ""
        ? action.userCode
        : null;
    });
    await fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: code });
    await waitFor(
      "idle view fixture running",
      async () => {
        const current = await view();
        if (current["state"] === "failed") throw new FatalProbeError(String(current["lastError"]));
        return current["state"] === "running" ? true : null;
      },
      { timeoutMs: 300_000, intervalMs: 500 },
    );

    const advanced = await clock.advanceTo(
      Date.now() + DEFAULT_LIFECYCLE_CONSTANTS.idleStopAfterMs + 60_000,
    );
    if (advanced.isErr()) throw new Error(`clock advance failed: ${advanced.error.type}`);
    await waitFor(
      "idle auto-stop",
      async () => {
        const current = await view();
        return current["state"] === "stopped" ? current : null;
      },
      { timeoutMs: 120_000, intervalMs: 500 },
    );
    expect((await view())["stopReason"]).toBe("idle");

    const frames: ServerFrame[] = [];
    socket = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/orbs/${orbId}/live`, [
      RUNTIME_SUBPROTOCOL,
    ]);
    const live = socket;
    live.on("message", (data) => frames.push(JSON.parse(data.toString()) as ServerFrame));
    live.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      live.once("open", () => resolve());
      live.once("error", reject);
    });
    live.send(JSON.stringify({ v: 1, type: "client.presence", visible: true }));
    live.send(
      JSON.stringify({
        v: 1,
        type: "client.hello",
        clientInstanceId: randomUUID(),
        afterRecordId: null,
      }),
    );
    await waitFor("live sync of the stopped orb", async () =>
      frames.some((frame) => frame.type === "sync.completed") ? true : null,
    );

    for (let pass = 0; pass < 3; pass += 1) {
      await forceReconcilePass(activeCp, orbId);
      const current = await view();
      expect(current["state"]).toBe("stopped");
      expect(current["stopReason"]).toBe("idle");
    }

    expect(
      (
        await api(cp.baseUrl, "PUT", `/api/v1/orbs/${orbId}/messages/${randomUUID()}`, {
          content: [{ type: "text", text: "wake on send" }],
        })
      ).status,
    ).toBe(202);
    await waitFor(
      "message starts the orb and is answered",
      async () => {
        const history = await api(activeCp.baseUrl, "GET", `/api/v1/orbs/${orbId}/history`);
        return (await view())["state"] === "running" &&
          JSON.stringify(history.body["records"]).includes("IDLE_VIEW_REPLY")
          ? true
          : null;
      },
      { timeoutMs: 300_000, intervalMs: 500 },
    );
  } catch (error) {
    failure = error;
  } finally {
    socket?.close();
    const cleanup = await Promise.allSettled([
      cp?.stop() ?? Promise.resolve(),
      fake === undefined ? Promise.resolve() : deleteFakeSession(fake.sessionKey),
      nameFake === undefined ? Promise.resolve() : deleteFakeSession(nameFake.sessionKey),
    ]);
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    cleanupErrors.push(
      ...cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    );
  }
  if (failure !== undefined) throw failure;
  if (cleanupErrors.length > 0)
    throw new AggregateError(cleanupErrors, "idle view E2E cleanup failed");
}, 720_000);
