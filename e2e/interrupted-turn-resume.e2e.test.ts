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
 * Interrupted-turn resume against a real host kill (docs/lifecycle.md,
 * "interrupted-turn resume at runtime boot").
 *
 * The orb runs a scripted turn whose bash tool call sleeps for minutes, the
 * test `docker kill`s the container mid-tool-call, and Docker's
 * `--restart unless-stopped` policy resurrects it. Nothing about the resume is
 * driven from the outside: the rebooting runtime reads its own session tail,
 * finds the dangling tool call, appends the visible resume marker with
 * `triggerTurn`, and the turn finishes. The assertions are made against the
 * replicated history in Postgres, so they cover the whole path — session file,
 * runtime boot, live publication, replication — not just the runtime's memory.
 *
 * The control plane is largely a bystander here: the container comes back on
 * its own, usually inside a single reconcile tick. If the reboot outruns the
 * unreachable grace the control plane may also restart the orb, which is a
 * different route to the same convergence; the test tolerates either and
 * asserts only the end state.
 */

const PG_CONTAINER = "pi-orb-e2e-resume-pg";
const PG_PORT = 5437;
const CP_PORT = 7145;
const NETWORK = "pi-orb";
const RUNTIME_IMAGE = "pi-orb-runtime:dev";
const REPOSITORY_URL = "https://github.com/schani/pi-orb";
const PROCESS_BACKEND = process.env["PI_ORB_E2E_BACKEND"] === "process";

/** Marker text of the resume record the runtime appends (turn-resume.ts). */
const RESUME_CUSTOM_TYPE = "pi-orb.turn-resume";
const DECLINE_CUSTOM_TYPE = "pi-orb.turn-resume-declined";

/** The user message that starts the long turn, and the closing text after it. */
const KICKOFF = "hold the line for the e2e interrupt drill";
const RESUME_OK = "E2E_RESUME_OK";
const SLEEP_COMMAND = "echo E2E_SLEEP_STARTED; sleep 300";

const SCENARIO = {
  auth: {
    accountId: "acct_pi_orb_e2e_resume",
    device: { manualApprove: true },
  },
  model: {
    rules: [
      // Listed first on purpose: after the resume the marker record is the
      // newest user-role message, and this rule must win over the kickoff rule
      // no matter how the fake scopes `userMessage`.
      {
        match: { userMessage: { regex: "resuming it now" } },
        steps: [
          {
            type: "text",
            content: `RESUME_MARKER_MATCH: the interrupted job is finished — ${RESUME_OK}.`,
            deltas: 4,
          },
          { type: "usage", input_tokens: 210, output_tokens: 14 },
          { type: "stop", status: "completed" },
        ],
      },
      {
        match: { userMessage: { regex: KICKOFF } },
        steps: [
          { type: "reasoning", text: "Starting the long-running check.", deltas: 3 },
          { type: "toolCall", name: "bash", arguments: { command: SLEEP_COMMAND } },
          { type: "usage", input_tokens: 130, output_tokens: 30 },
          { type: "stop", status: "completed" },
        ],
      },
      {
        match: { default: true },
        steps: [
          {
            type: "text",
            content: `DEFAULT_MATCH: the interrupted job is finished — ${RESUME_OK}.`,
            deltas: 4,
          },
          { type: "usage", input_tokens: 210, output_tokens: 14 },
          { type: "stop", status: "completed" },
        ],
      },
    ],
  },
};

const NAME_SCENARIO = {
  auth: { accountId: "acct_pi_orb_e2e_resume" },
  model: {
    rules: [
      {
        match: { default: true },
        steps: [
          { type: "text", content: "Resume Interrupted Job" },
          { type: "stop", status: "completed" },
        ],
      },
    ],
  },
};

/** Just enough of one recorded fake request to inspect the resumed turn. */
interface ModelRequest {
  surface?: string;
  body?: { input?: Record<string, unknown>[] };
}

interface EventRecord {
  type: string;
  eventType?: string;
  overflow?: { native?: Record<string, unknown> };
}

/** Every replicated custom-message record of one custom type, newest last. */
function customRecords(records: unknown[], customType: string): Record<string, unknown>[] {
  return records
    .filter((record): record is EventRecord => typeof record === "object" && record !== null)
    .filter((record) => record.type === "event" && record.eventType === "pi.custom_message")
    .map((record) => record.overflow?.native)
    .filter(
      (native): native is Record<string, unknown> =>
        typeof native === "object" && native !== null && native["customType"] === customType,
    );
}

let fake: FakeSession;
let nameFake: FakeSession;
let controlPlane: ControlPlaneHandle;
let orbId = "";

beforeAll(async () => {
  if (PROCESS_BACKEND) return;
  fake = await createFakeSession(`pi-orb-e2e-resume-${Date.now()}`, SCENARIO);
  nameFake = await createFakeSession(`pi-orb-name-e2e-resume-${Date.now()}`, NAME_SCENARIO);

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
    nameFake,
    dockerNetwork: NETWORK,
    runtimeImage: RUNTIME_IMAGE,
  });
}, 720_000);

afterAll(async () => {
  if (PROCESS_BACKEND) return;
  if (orbId !== "") {
    await docker(["rm", "-f", `pi-orb-${orbId}`]).catch(() => undefined);
    await docker(["volume", "rm", "-f", `pi-orb-data-${orbId}`]).catch(() => undefined);
  }
  await controlPlane?.stop();
  await docker(["rm", "-f", PG_CONTAINER]).catch(() => undefined);
  if (fake !== undefined) await deleteFakeSession(fake.sessionKey);
  if (nameFake !== undefined) await deleteFakeSession(nameFake.sessionKey);
}, 120_000);

describe("interrupted-turn resume E2E", () => {
  it.skipIf(PROCESS_BACKEND)(
    "resumes a turn a docker kill interrupted mid-tool-call",
    async () => {
      try {
        await runScenario();
      } catch (error) {
        console.error("=== control-plane logs (tail) ===");
        console.error(controlPlane.logs.join("").split("\n").slice(-60).join("\n"));
        if (orbId !== "") {
          const view = await api(controlPlane.baseUrl, "GET", `/api/v1/orbs/${orbId}`).catch(
            () => null,
          );
          console.error("=== orb view ===", JSON.stringify(view?.body));
          const history = await api(
            controlPlane.baseUrl,
            "GET",
            `/api/v1/orbs/${orbId}/history`,
          ).catch(() => null);
          console.error(
            "=== replicated history ===",
            JSON.stringify(history?.body).slice(0, 20_000),
          );
          const logs = await docker(["logs", "--tail", "80", `pi-orb-${orbId}`]).catch(
            (e: unknown) => `unavailable: ${String(e)}`,
          );
          console.error("=== orb container logs ===\n", logs);
          const requests = await fakeControl(fake.sessionKey, "/requests").catch(() => null);
          console.error("=== fake requests ===", JSON.stringify(requests).slice(0, 20_000));
        }
        throw error;
      }
    },
    720_000,
  );

  async function runScenario(): Promise<void> {
    const base = controlPlane.baseUrl;

    const projectId = randomUUID();
    const project = await api(base, "POST", "/api/v1/projects", {
      id: projectId,
      name: `e2e-resume-${projectId.slice(0, 8)}`,
      repositoryUrl: REPOSITORY_URL,
    });
    expect(project.status, JSON.stringify(project.body)).toBe(201);
    orbId = randomUUID();
    const container = `pi-orb-${orbId}`;
    const orb = await api(base, "POST", `/api/v1/projects/${projectId}/orbs`, { id: orbId });
    expect(orb.status, JSON.stringify(orb.body)).toBe(202);

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

    // Live connection through the proxy, only to start the turn and to witness
    // the tool call going live. Everything after the kill is asserted against
    // replicated history, because this socket dies with the container.
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
    socket.on("error", () => undefined);
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
          content: [{ type: "text", text: KICKOFF }],
        },
      }),
    );
    const accepted = await untilFrame("request.result", () =>
      frames.find((frame) => frame.type === "request.result" && frame.requestId === requestId),
    );
    expect(accepted.type === "request.result" && accepted.result.type).toBe("accepted");

    // The bash tool is live inside the orb...
    await untilFrame(
      "bash tool running",
      () =>
        frames.find(
          (frame) =>
            frame.type === "runtime.event" &&
            frame.event.type === "tool_state" &&
            frame.event.name === "bash" &&
            frame.event.state === "running",
        ),
      180_000,
    );
    // ...and, decisively, the assistant message holding the tool call is on
    // disk and replicated. Without this the kill could land before the entry is
    // persisted and the tail would be an unanswered user message instead.
    await waitFor(
      "assistant tool call replicated",
      async () => {
        const snapshot = await api(base, "GET", `/api/v1/orbs/${orbId}/history`);
        const serialized = JSON.stringify(snapshot.body["records"]);
        return serialized.includes(SLEEP_COMMAND) ? true : null;
      },
      { timeoutMs: 90_000, intervalMs: 1_000 },
    );

    const startedAtBefore = await docker([
      "inspect",
      "--format",
      "{{.State.StartedAt}}",
      container,
    ]);
    const killedAt = Date.now();
    await docker(["kill", container]);
    socket.close();

    // Docker's restart policy brings the same container back.
    const restartedAt = await waitFor(
      "container restarted",
      async () => {
        const line = await docker([
          "inspect",
          "--format",
          "{{.State.Running}} {{.State.StartedAt}}",
          container,
        ]).catch(() => "");
        const [running, startedAt] = line.split(" ");
        return running === "true" && startedAt !== startedAtBefore ? Date.now() : null;
      },
      { timeoutMs: 180_000, intervalMs: 500 },
    );
    console.log(`[resume] container back after ${restartedAt - killedAt} ms`);

    // The runtime decides on its own, from its own session tail. The proof is
    // the replicated marker plus the closing text of the continued turn.
    const resumed = await waitFor(
      "resume marker and closing text replicated",
      async () => {
        const snapshot = await api(base, "GET", `/api/v1/orbs/${orbId}/history`);
        const records = snapshot.body["records"] as unknown[];
        const markers = customRecords(records, RESUME_CUSTOM_TYPE);
        if (markers.length === 0) return null;
        return JSON.stringify(records).includes(RESUME_OK) ? { records, markers } : null;
      },
      { timeoutMs: 300_000, intervalMs: 2_000 },
    );
    console.log(`[resume] turn completed ${Date.now() - killedAt} ms after the kill`);

    // Exactly one resume, never a second one, and never a decline.
    expect(resumed.markers.length, "exactly one resume marker").toBe(1);
    expect(customRecords(resumed.records, DECLINE_CUSTOM_TYPE).length, "no decline marker").toBe(0);

    const marker = resumed.markers[0] as Record<string, unknown>;
    expect(marker["display"]).toBe(true);
    const details = marker["details"] as Record<string, unknown> | undefined;
    const shape = details?.["shape"];
    const headRecordId = details?.["headRecordId"];
    console.log(`[resume] shape=${String(shape)} headRecordId=${String(headRecordId)}`);
    // Killing mid-`sleep` should leave the assistant's tool calls dangling; a
    // tool result that managed to flush first is the other legal reading of the
    // same interruption, so both are accepted and the actual one is logged.
    expect(["dangling_tool_calls", "trailing_tool_result"]).toContain(shape);
    expect(typeof headRecordId, "marker carries the tail entry id").toBe("string");

    const closing = /(RESUME_MARKER_MATCH|DEFAULT_MATCH)[^"]*/.exec(
      JSON.stringify(resumed.records),
    );
    console.log(`[resume] continuation text: ${closing?.[0] ?? "(not found)"}`);

    // The continuation really went through the model path. The request it made
    // is the one thing about this feature no unit test can reach: an assistant
    // message whose tool calls were never answered is not a valid model
    // request, so *something* has to close the dangling call. Pi does it, and
    // this assertion is what would catch it silently stopping.
    const requests = (await fakeControl(fake.sessionKey, "/requests")) as unknown as ModelRequest[];
    const resumeRequest = requests.find(
      (request) =>
        request.surface === "model" &&
        JSON.stringify(request.body?.input ?? []).includes("resuming it now"),
    );
    expect(resumeRequest, "the resumed turn reached the model").toBeDefined();
    const input = resumeRequest?.body?.input ?? [];
    const call = input.find((item) => item["type"] === "function_call");
    expect(JSON.stringify(call), "the interrupted tool call is in the resumed request").toContain(
      "sleep 300",
    );
    const answer = input.find(
      (item) => item["type"] === "function_call_output" && item["call_id"] === call?.["call_id"],
    );
    expect(answer, "the dangling tool call is answered in the resumed request").toBeDefined();
    console.log(`[resume] dangling call answered with ${JSON.stringify(answer?.["output"])}`);

    // Whatever route recovery took — Docker's restart policy alone or an
    // additional unreachable restart from the control plane — the orb converges
    // back to running.
    await waitFor(
      "orb running after recovery",
      async () => {
        const view = await api(base, "GET", `/api/v1/orbs/${orbId}`);
        if (view.body["state"] === "failed") {
          throw new FatalProbeError(`orb failed: ${String(view.body["lastError"])}`);
        }
        return view.body["state"] === "running" ? true : null;
      },
      { timeoutMs: 300_000, intervalMs: 2_000 },
    );

    const stop = await api(base, "POST", `/api/v1/orbs/${orbId}/stop`);
    expect(stop.status).toBe(202);
    await waitFor(
      "orb stopped",
      async () => {
        const view = await api(base, "GET", `/api/v1/orbs/${orbId}`);
        return view.body["state"] === "stopped" ? true : null;
      },
      { timeoutMs: 180_000, intervalMs: 2_000 },
    );

    const stopped = await api(base, "GET", `/api/v1/orbs/${orbId}/history`);
    const stoppedRecords = stopped.body["records"] as unknown[];
    expect(customRecords(stoppedRecords, RESUME_CUSTOM_TYPE).length).toBe(1);
    expect(JSON.stringify(stoppedRecords)).toContain(RESUME_OK);
  }
});
