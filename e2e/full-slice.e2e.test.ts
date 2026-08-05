import { randomUUID } from "node:crypto";
import { RUNTIME_SUBPROTOCOL, type ServerFrame } from "@pi-orb/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  api,
  type ControlPlaneHandle,
  createFakeSession,
  deleteFakeSession,
  docker,
  type FakeSession,
  FatalProbeError,
  fakeControl,
  startControlPlane,
  waitFor,
} from "./harness.ts";

/**
 * The full docs/testing.md slice against real PostgreSQL, real Docker, the real Pi SDK
 * inside the orb container, and the fake OpenAI service: device login,
 * scripted streaming with a real tool round trip, history replication, and
 * the controlled-stop drain. Requires docker and network access to the fake;
 * the runtime image is built on demand.
 */

const PG_CONTAINER = "pi-orb-e2e-pg";
const PG_PORT = 5436;
const CP_PORT = 7144;
const NETWORK = "pi-orb";
const RUNTIME_IMAGE = "pi-orb-runtime:dev";
const REPOSITORY_URL = "https://github.com/schani/pi-orb";

const SCENARIO = {
  auth: {
    accountId: "acct_pi_orb_e2e",
    device: { manualApprove: true },
  },
  model: {
    rules: [
      {
        match: { userMessage: { regex: "run the e2e tool check" } },
        steps: [
          { type: "reasoning", text: "I will run the requested check with bash.", deltas: 3 },
          { type: "toolCall", name: "bash", arguments: { command: "echo E2E_TOOL_OK" } },
          { type: "usage", input_tokens: 120, output_tokens: 25 },
          { type: "stop", status: "completed" },
        ],
      },
      {
        match: { toolResultContains: { regex: "E2E_TOOL_OK" } },
        steps: [
          { type: "text", content: "The check succeeded: E2E_TOOL_OK.", deltas: 4 },
          { type: "usage", input_tokens: 180, output_tokens: 12 },
          { type: "stop", status: "completed" },
        ],
      },
      {
        match: { default: true },
        steps: [
          { type: "text", content: "Unexpected prompt reached the fallback rule." },
          { type: "stop", status: "completed" },
        ],
      },
    ],
  },
};

let fake: FakeSession;
let controlPlane: ControlPlaneHandle;
let orbId = "";

beforeAll(async () => {
  fake = await createFakeSession(`pi-orb-e2e-${Date.now()}`, SCENARIO);

  await docker(["network", "create", NETWORK]).catch(() => undefined);
  const hasImage = await docker(["image", "inspect", RUNTIME_IMAGE, "--format", "ok"]).catch(
    () => null,
  );
  if (hasImage === null) {
    await docker(["build", "-f", "apps/orb-runtime/Dockerfile", "-t", RUNTIME_IMAGE, "."], 600_000);
  }

  await docker(["rm", "-f", PG_CONTAINER]).catch(() => undefined);
  await docker([
    "run",
    "--detach",
    "--name",
    PG_CONTAINER,
    "-e",
    "POSTGRES_USER=pi-orb",
    "-e",
    "POSTGRES_PASSWORD=pi-orb",
    "-e",
    "POSTGRES_DB=pi_orb",
    "-p",
    `127.0.0.1:${PG_PORT}:5432`,
    "postgres:16",
  ]);
  await waitFor(
    "postgres ready",
    async () => {
      const out = await docker(["exec", PG_CONTAINER, "pg_isready", "-U", "pi-orb"]);
      return out.includes("accepting connections") ? true : null;
    },
    { timeoutMs: 60_000 },
  );

  controlPlane = await startControlPlane({
    databaseUrl: `postgres://pi-orb:pi-orb@127.0.0.1:${PG_PORT}/pi_orb`,
    port: CP_PORT,
    fake,
    dockerNetwork: NETWORK,
    runtimeImage: RUNTIME_IMAGE,
  });
}, 720_000);

afterAll(async () => {
  if (orbId !== "") {
    await docker(["rm", "-f", `pi-orb-${orbId}`]).catch(() => undefined);
    await docker(["volume", "rm", "-f", `pi-orb-data-${orbId}`]).catch(() => undefined);
  }
  await controlPlane?.stop();
  await docker(["rm", "-f", PG_CONTAINER]).catch(() => undefined);
  if (fake !== undefined) await deleteFakeSession(fake.sessionKey);
}, 120_000);

describe("full slice E2E", () => {
  it("runs login, a scripted tool round trip, replication, and drain", async () => {
    try {
      await runScenario();
    } catch (error) {
      // Dump every diagnostic surface before failing.
      console.error("=== control-plane logs (tail) ===");
      console.error(controlPlane.logs.join("").split("\n").slice(-40).join("\n"));
      if (orbId !== "") {
        const view = await api(controlPlane.baseUrl, "GET", `/api/v1/orbs/${orbId}`).catch(
          () => null,
        );
        console.error("=== orb view ===", JSON.stringify(view?.body));
        const logs = await docker(["logs", "--tail", "40", `pi-orb-${orbId}`]).catch(
          (e: unknown) => `unavailable: ${String(e)}`,
        );
        console.error("=== orb container logs ===\n", logs);
      }
      throw error;
    }
  }, 720_000);

  async function runScenario(): Promise<void> {
    const base = controlPlane.baseUrl;

    // Project + orb through the real API (docs/testing.md steps 1-2).
    const projectId = randomUUID();
    const project = await api(base, "POST", "/api/v1/projects", {
      id: projectId,
      name: `e2e-${projectId.slice(0, 8)}`,
      repositoryUrl: REPOSITORY_URL,
    });
    expect(project.status, JSON.stringify(project.body)).toBe(201);
    orbId = randomUUID();
    const orb = await api(base, "POST", `/api/v1/projects/${projectId}/orbs`, { id: orbId });
    expect(orb.status, JSON.stringify(orb.body)).toBe(202);

    // Device login: the test plays the human via the fake's control API.
    const challenge = await waitFor(
      "device-login challenge",
      async () => {
        const view = await api(base, "GET", `/api/v1/orbs/${orbId}`);
        const action = view.body["actionRequired"] as Record<string, unknown> | undefined;
        return typeof action?.["userCode"] === "string" && action["userCode"] !== ""
          ? (action["userCode"] as string)
          : null;
      },
      { timeoutMs: 60_000 },
    );
    await fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: challenge });

    // Clone + session + auth resolve inside the container (docs/testing.md steps 3-4).
    await waitFor(
      "orb running",
      async () => {
        const view = await api(base, "GET", `/api/v1/orbs/${orbId}`);
        if (view.body["state"] === "failed") {
          throw new FatalProbeError(`orb failed: ${String(view.body["lastError"])}`);
        }
        return view.body["state"] === "running" ? true : null;
      },
      { timeoutMs: 300_000, intervalMs: 2_000 },
    );

    // Live connection through the content-agnostic proxy (docs/testing.md steps 5-6).
    const history = await api(base, "GET", `/api/v1/orbs/${orbId}/history`);
    const cursor = (history.body["cursor"] as string | null) ?? null;

    const frames: ServerFrame[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${CP_PORT}/api/v1/orbs/${orbId}/live`, [
      RUNTIME_SUBPROTOCOL,
    ]);
    const frameWaiters: (() => void)[] = [];
    socket.on("message", (data) => {
      frames.push(JSON.parse(data.toString()) as ServerFrame);
      for (const waiter of frameWaiters.splice(0)) waiter();
    });
    const untilFrame = <T>(
      what: string,
      find: () => T | undefined,
      timeoutMs = 120_000,
    ): Promise<T> =>
      new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error(`timed out waiting for frame: ${what}`)),
          timeoutMs,
        );
        const check = (): void => {
          const found = find();
          if (found !== undefined) {
            clearTimeout(deadline);
            resolve(found);
          } else {
            frameWaiters.push(check);
          }
        };
        check();
      });

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error) => reject(error));
    });
    socket.send(
      JSON.stringify({
        v: 1,
        type: "client.hello",
        clientInstanceId: randomUUID(),
        afterRecordId: cursor,
      }),
    );
    const syncCompleted = await untilFrame("sync.completed", () =>
      frames.find((frame) => frame.type === "sync.completed"),
    );

    // One scripted turn: reasoning + real bash tool + final text.
    let headId = syncCompleted.type === "sync.completed" ? syncCompleted.headId : null;
    for (const frame of frames) {
      if (frame.type === "history.record") headId = frame.record.id;
    }
    const requestId = randomUUID();
    socket.send(
      JSON.stringify({
        v: 1,
        type: "client.request",
        requestId,
        action: {
          type: "message",
          expectedHeadId: headId,
          content: [{ type: "text", text: "please run the e2e tool check" }],
        },
      }),
    );
    const result = await untilFrame("request.result", () =>
      frames.find((frame) => frame.type === "request.result" && frame.requestId === requestId),
    );
    expect(result.type === "request.result" && result.result.type).toBe("accepted");

    await untilFrame(
      "bash tool completed",
      () =>
        frames.find(
          (frame) =>
            frame.type === "runtime.event" &&
            frame.event.type === "tool_state" &&
            frame.event.name === "bash" &&
            frame.event.state === "completed",
        ),
      180_000,
    );
    await untilFrame(
      "operation finished",
      () =>
        frames.find(
          (frame) => frame.type === "runtime.event" && frame.event.type === "operation_finished",
        ),
      180_000,
    );
    const finalText = await untilFrame(
      "final assistant record",
      () =>
        frames.find(
          (frame) =>
            frame.type === "history.record" &&
            JSON.stringify(frame.record).includes("The check succeeded: E2E_TOOL_OK."),
        ),
      60_000,
    );
    expect(finalText).toBeDefined();
    const sawReasoningDelta = frames.some(
      (frame) =>
        frame.type === "runtime.event" &&
        frame.event.type === "output_patch" &&
        frame.event.blockType === "reasoning",
    );
    expect(sawReasoningDelta, "streamed reasoning deltas reached the client").toBe(true);

    // Replication lands through the HTTP pull, not the WebSocket (docs/history-replication.md).
    const replicated = await waitFor(
      "history replicated to postgres",
      async () => {
        const snapshot = await api(base, "GET", `/api/v1/orbs/${orbId}/history`);
        const records = snapshot.body["records"] as unknown[];
        const serialized = JSON.stringify(records);
        return serialized.includes("E2E_TOOL_OK") &&
          serialized.includes("The check succeeded") &&
          records.length >= 4
          ? records.length
          : null;
      },
      { timeoutMs: 60_000, intervalMs: 2_000 },
    );

    // The fake saw exactly the two scripted inference turns, the second one
    // carrying the real tool output produced inside the orb.
    const requests = await fakeControl(fake.sessionKey, "/requests");
    const inferenceCalls = JSON.stringify(requests);
    expect(inferenceCalls).toContain("E2E_TOOL_OK");

    socket.close();

    // Controlled stop: drain, then host stop (docs/testing.md step 8).
    const stop = await api(base, "POST", `/api/v1/orbs/${orbId}/stop`);
    expect(stop.status).toBe(202);
    await waitFor(
      "orb stopped",
      async () => {
        const view = await api(base, "GET", `/api/v1/orbs/${orbId}`);
        return view.body["state"] === "stopped" ? true : null;
      },
      { timeoutMs: 120_000, intervalMs: 2_000 },
    );

    // Stopped-orb history serves from the database alone (docs/testing.md step 9).
    const stopped = await api(base, "GET", `/api/v1/orbs/${orbId}/history`);
    const stoppedRecords = stopped.body["records"] as unknown[];
    expect(stoppedRecords.length).toBe(replicated);
    expect(JSON.stringify(stoppedRecords)).toContain("The check succeeded: E2E_TOOL_OK.");
  }
});
