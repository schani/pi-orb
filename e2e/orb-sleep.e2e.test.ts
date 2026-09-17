import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";
import {
  api,
  type ControlPlaneHandle,
  createFakeSession,
  deleteFakeSession,
  type FakeSession,
  FatalProbeError,
  fakeControl,
  newModelRequestsById,
  requestIds,
  startControlPlane,
  waitFor,
} from "./harness.ts";

const stop = { type: "stop", status: "completed" } as const;
const NAME_SCENARIO = {
  auth: { accountId: "acct_pi_orb_e2e" },
  model: {
    rules: [
      {
        match: { default: true },
        steps: [{ type: "text", content: "Run E2E Tool Check" }, stop],
      },
    ],
  },
};

it("retains a real sleep CLI turn, stops, and wakes with one combined system notice", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-sleep-e2e-"));
  const projectId = randomUUID();
  const orbId = randomUUID();
  let fake: FakeSession | undefined;
  let nameFake: FakeSession | undefined;
  let cp: ControlPlaneHandle | undefined;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    fake = await createFakeSession(`orb-sleep-${randomUUID()}`, {
      auth: { accountId: "orb-sleep-test", device: { manualApprove: true } },
      model: {
        rules: [
          {
            match: { userMessage: { regex: "^schedule the owned sleep$" } },
            steps: [
              {
                type: "toolCall",
                name: "bash",
                arguments: { command: "pi-orb sleep 1d" },
              },
              stop,
            ],
          },
          {
            match: {
              toolResultContains: { regex: "Sleep scheduled until .*Z\\." },
            },
            steps: [{ type: "text", content: "SLEEP_ACCEPTED_FINAL" }, stop],
          },
          {
            match: {
              userMessage: {
                regex: "^Write a single short desktop-notification sentence",
              },
            },
            steps: [{ type: "text", content: "Scheduled sleep." }, stop],
          },
          {
            match: {
              userMessage: {
                regex:
                  "(The (host|agent runtime) was restarted\\.[\\s\\S]*Scheduled sleep finished|Scheduled sleep finished[\\s\\S]*The (host|agent runtime) was restarted\\.)",
              },
            },
            steps: [{ type: "text", content: "SLEEP_WAKE_FINAL" }, stop],
          },
          {
            match: { default: true },
            steps: [{ type: "text", content: "UNEXPECTED_SLEEP_E2E_PROMPT" }, stop],
          },
        ],
      },
    });
    nameFake = await createFakeSession(`orb-sleep-names-${randomUUID()}`, NAME_SCENARIO);
    const webRoot = join(import.meta.dirname, "../apps/web");
    await build({
      root: webRoot,
      configFile: join(webRoot, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir: join(root, "web"), emptyOutDir: true },
    });
    const epoch = Date.now();
    cp = await startControlPlane({
      port: 7181,
      fake,
      nameFake,
      pglitePath: join(root, "db"),
      processStateDirectory: join(root, "hosts"),
      authDir: join(root, "auth"),
      hostingRoot: join(root, "hosting"),
      webDist: join(root, "web"),
      controlledClockEpoch: epoch,
    });
    const activeFake = fake;
    const activeCp = cp;
    const clock = activeCp.clock;
    if (clock === undefined) throw new Error("controlled clock was not attached");
    expect(
      (
        await api(cp.baseUrl, "POST", "/api/v1/projects", {
          id: projectId,
          name: "Scheduled sleep E2E",
          repositoryUrl: "https://github.com/schani/pi-orb",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api(cp.baseUrl, "POST", `/api/v1/projects/${projectId}/orbs`, {
          id: orbId,
        })
      ).status,
    ).toBe(202);
    const code = await waitFor("sleep fixture login", async () => {
      const view = await api(activeCp.baseUrl, "GET", `/api/v1/orbs/${orbId}`);
      const action = view.body["actionRequired"] as { userCode?: unknown } | undefined;
      return typeof action?.userCode === "string" ? action.userCode : null;
    });
    await fakeControl(fake.sessionKey, "/deviceauth/approve", {
      user_code: code,
    });
    await waitFor(
      "sleep fixture running",
      async () => {
        const view = await api(activeCp.baseUrl, "GET", `/api/v1/orbs/${orbId}`);
        if (view.body["state"] === "failed")
          throw new FatalProbeError(String(view.body["lastError"]));
        return view.body["state"] === "running" ? true : null;
      },
      { timeoutMs: 300_000, intervalMs: 500 },
    );

    const requestsBeforeSleep = (await fakeControl(fake.sessionKey, "/requests")) as unknown as {
      status?: number;
      body?: unknown;
    }[];
    const settledNotificationsBeforeSleep = requestsBeforeSleep.filter(
      (request) =>
        request.status === 200 &&
        JSON.stringify(request.body).includes("Write a single short desktop-notification sentence"),
    ).length;
    expect(
      (
        await api(cp.baseUrl, "PUT", `/api/v1/orbs/${orbId}/messages/${randomUUID()}`, {
          content: [{ type: "text", text: "schedule the owned sleep" }],
        })
      ).status,
    ).toBe(202);

    const sleepUntil = await waitFor(
      "real CLI result and final reply retained",
      async () => {
        const view = await api(activeCp.baseUrl, "GET", `/api/v1/orbs/${orbId}`);
        const history = await api(activeCp.baseUrl, "GET", `/api/v1/orbs/${orbId}/history`);
        const serialized = JSON.stringify(history.body["records"]);
        return typeof view.body["sleepUntil"] === "string" &&
          serialized.includes("Sleep scheduled until") &&
          serialized.includes("SLEEP_ACCEPTED_FINAL")
          ? String(view.body["sleepUntil"])
          : null;
      },
      { timeoutMs: 120_000, intervalMs: 500 },
    );
    await waitFor(
      "sleep-turn Luna request settled",
      async () => {
        const requests: unknown = await fakeControl(activeFake.sessionKey, "/requests");
        return Array.isArray(requests) &&
          requests.filter(
            (request) =>
              request.status === 200 &&
              JSON.stringify(request.body).includes(
                "Write a single short desktop-notification sentence",
              ),
          ).length > settledNotificationsBeforeSleep
          ? true
          : null;
      },
      { timeoutMs: 30_000, intervalMs: 200 },
    );

    await waitFor(
      "sleep stopped its owned compute",
      async () => {
        const view = await api(activeCp.baseUrl, "GET", `/api/v1/orbs/${orbId}`);
        const metadataPath = join(root, "hosts", orbId, "host.json");
        if (!existsSync(metadataPath)) return null;
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
          desiredState?: string;
          processGroupId?: unknown;
        };
        return view.body["state"] === "stopped" &&
          metadata.desiredState === "stopped" &&
          metadata.processGroupId === null
          ? true
          : null;
      },
      { timeoutMs: 120_000, intervalMs: 500 },
    );
    const stoppedHistory = await api(cp.baseUrl, "GET", `/api/v1/orbs/${orbId}/history`);
    expect(JSON.stringify(stoppedHistory.body["records"])).toContain("Sleep scheduled until");
    expect(JSON.stringify(stoppedHistory.body["records"])).toContain("SLEEP_ACCEPTED_FINAL");
    const ownedRequestIdsBeforeWake = requestIds(
      (await fakeControl(activeFake.sessionKey, "/requests")) as unknown as unknown[],
    );

    const advanced = await clock.advanceTo(Date.parse(sleepUntil));
    expect(advanced.isOk()).toBe(true);
    if (advanced.isErr()) throw new Error(`clock advance failed: ${advanced.error.type}`);
    expect(advanced.value.now).toBeGreaterThanOrEqual(Date.parse(sleepUntil));

    await waitFor(
      "scheduled wake reply retained",
      async () => {
        const view = await api(activeCp.baseUrl, "GET", `/api/v1/orbs/${orbId}`);
        if (view.body["state"] === "failed")
          throw new FatalProbeError(String(view.body["lastError"]));
        const history = await api(activeCp.baseUrl, "GET", `/api/v1/orbs/${orbId}/history`);
        return view.body["state"] === "running" &&
          JSON.stringify(history.body["records"]).includes("SLEEP_WAKE_FINAL")
          ? true
          : null;
      },
      { timeoutMs: 300_000, intervalMs: 500 },
    );

    const ownedRequestsAfterWake = (await fakeControl(
      activeFake.sessionKey,
      "/requests",
    )) as unknown as unknown[];
    const [firstWakeRequest] = newModelRequestsById(
      ownedRequestsAfterWake,
      ownedRequestIdsBeforeWake,
    );
    const firstWakeBody = JSON.stringify(firstWakeRequest?.body);
    expect(firstWakeBody).toMatch(/The (host|agent runtime) was restarted\./);
    expect(firstWakeBody).toContain("Scheduled sleep finished");

    const history = await api(cp.baseUrl, "GET", `/api/v1/orbs/${orbId}/history`);
    const records = history.body["records"] as {
      type?: string;
      custom?: { customType?: string };
      inboxMessageIds?: string[];
    }[];
    const sleepRecords = records.filter(
      (record) => record.type === "event" && record.custom?.customType === "pi-orb.sleep-wake",
    );
    expect(sleepRecords).toHaveLength(1);
    expect(sleepRecords[0]?.inboxMessageIds).toHaveLength(1);
    const messages = await api(cp.baseUrl, "GET", `/api/v1/orbs/${orbId}/messages`);
    expect(
      (messages.body["items"] as { system?: { kind?: string } }[]).filter(
        (message) => message.system?.kind === "sleep_wake",
      ),
    ).toHaveLength(1);
  } catch (error) {
    failure = error;
    const runId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
    const evidence = join(import.meta.dirname, "../.context/orb-sleep/evidence", runId);
    console.error(`orb-sleep E2E evidence: ${evidence}`);
    try {
      mkdirSync(evidence, { recursive: true });
      const outputs = ["failure.txt", "manifest.json"];
      writeFileSync(
        join(evidence, "failure.txt"),
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      if (cp !== undefined) {
        writeFileSync(join(evidence, "control-plane.log"), cp.logs.join(""));
        outputs.push("control-plane.log");
        for (const [name, path] of [
          ["orb-view.json", `/api/v1/orbs/${orbId}`],
          ["history.json", `/api/v1/orbs/${orbId}/history`],
          ["messages.json", `/api/v1/orbs/${orbId}/messages`],
        ] as const) {
          const result = await api(cp.baseUrl, "GET", path).catch((diagnosticError: unknown) => ({
            diagnosticError: String(diagnosticError),
          }));
          writeFileSync(join(evidence, name), JSON.stringify(result, null, 2));
          outputs.push(name);
        }
      }
      if (fake !== undefined) {
        const requests = await fakeControl(fake.sessionKey, "/requests").catch(
          (diagnosticError: unknown) => ({
            diagnosticError: String(diagnosticError),
          }),
        );
        writeFileSync(join(evidence, "fake-requests.json"), JSON.stringify(requests, null, 2));
        outputs.push("fake-requests.json");
      }
      const hostDirectory = join(root, "hosts", orbId);
      if (existsSync(hostDirectory)) {
        cpSync(hostDirectory, join(evidence, "host"), { recursive: true });
        outputs.push("host");
      }
      writeFileSync(
        join(evidence, "manifest.json"),
        JSON.stringify(
          {
            runId,
            evidencePath: evidence,
            projectId,
            orbId,
            outputs,
          },
          null,
          2,
        ),
      );
    } catch (diagnosticError) {
      console.error("orb-sleep E2E evidence collection failed", diagnosticError);
    }
  } finally {
    const cleanup = await Promise.allSettled([
      cp?.stop() ?? Promise.resolve(),
      fake === undefined ? Promise.resolve() : deleteFakeSession(fake.sessionKey),
      nameFake === undefined ? Promise.resolve() : deleteFakeSession(nameFake.sessionKey),
    ]);
    let rootCleanupError: unknown;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      rootCleanupError = error;
    }
    cleanupErrors.push(
      ...cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    );
    if (rootCleanupError !== undefined) cleanupErrors.push(rootCleanupError);
  }
  if (failure !== undefined) throw failure;
  if (cleanupErrors.length > 0)
    throw new AggregateError(cleanupErrors, "orb-sleep E2E cleanup failed");
}, 720_000);
