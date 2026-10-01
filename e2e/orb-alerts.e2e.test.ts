import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect as expectPage } from "@playwright/test";
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
const message = "CLI ALERT INSIDE BUSY TOOL";

it("persists a real CLI alert while the Pi bash tool is active, replicates and acknowledges without another turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-alert-e2e-"));
  const orbId = randomUUID();
  const projectId = randomUUID();
  const requestId = randomUUID();
  let fake: FakeSession | undefined;
  let nameFake: FakeSession | undefined;
  let cp: ControlPlaneHandle | undefined;
  let failure: unknown;
  try {
    fake = await createFakeSession(`orb-alert-${randomUUID()}`, {
      auth: { accountId: "orb-alert-test", device: { manualApprove: true } },
      model: {
        rules: [
          {
            match: { userMessage: { regex: "^send the real alert$" } },
            steps: [
              {
                type: "toolCall",
                name: "bash",
                arguments: {
                  command: `pi-orb alert '${message}' --request-id ${requestId} && pi-orb alert '${message}' --request-id ${requestId}`,
                },
              },
              stop,
            ],
          },
          {
            match: { toolResultContains: { regex: "Alert saved" } },
            steps: [{ type: "text", content: "ALERT_TOOL_COMPLETED" }, stop],
          },
          {
            match: { default: true },
            steps: [{ type: "text", content: "UNEXPECTED_ALERT_TURN" }, stop],
          },
        ],
      },
    });
    nameFake = await createFakeSession(`orb-alert-names-${randomUUID()}`, {
      auth: { accountId: "acct_pi_orb_e2e" },
      model: {
        rules: [
          { match: { default: true }, steps: [{ type: "text", content: "Alert fixture" }, stop] },
        ],
      },
    });
    const webRoot = join(import.meta.dirname, "../apps/web");
    await build({
      root: webRoot,
      configFile: join(webRoot, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir: join(root, "web"), emptyOutDir: true },
    });
    cp = await startControlPlane({
      port: 7293,
      fake,
      nameFake,
      pglitePath: join(root, "db"),
      processStateDirectory: join(root, "hosts"),
      authDir: join(root, "auth"),
      hostingRoot: join(root, "hosting"),
      webDist: join(root, "web"),
    });
    const activeCp = cp;
    expect(
      (
        await api(cp.baseUrl, "POST", "/api/v1/projects", {
          id: projectId,
          name: "Alert E2E",
          repositoryUrl: "https://github.com/schani/pi-orb",
        })
      ).status,
    ).toBe(201);
    expect(
      (await api(cp.baseUrl, "POST", `/api/v1/projects/${projectId}/orbs`, { id: orbId })).status,
    ).toBe(202);
    const code = await waitFor("alert fixture login", async () => {
      const view = await api(activeCp.baseUrl, "GET", `/api/v1/orbs/${orbId}`);
      const action = view.body["actionRequired"] as
        | { userCode?: string; verificationUri?: string }
        | undefined;
      return action?.userCode && action.verificationUri ? action.userCode : null;
    });
    await fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: code });
    await waitFor(
      "alert fixture running",
      async () => {
        const view = await api(activeCp.baseUrl, "GET", `/api/v1/orbs/${orbId}`);
        if (view.body["state"] === "failed")
          throw new FatalProbeError(String(view.body["lastError"]));
        return view.body["state"] === "running" ? true : null;
      },
      { timeoutMs: 300_000, intervalMs: 500 },
    );
    const before = requestIds(
      (await fakeControl(fake.sessionKey, "/requests")) as unknown as unknown[],
    );
    expect(
      (
        await api(cp.baseUrl, "PUT", `/api/v1/orbs/${orbId}/messages/${randomUUID()}`, {
          content: [{ type: "text", text: "send the real alert" }],
        })
      ).status,
    ).toBe(202);
    const alertId = await waitFor(
      "busy-tool CLI alert committed and replicated",
      async () => {
        const view = await api(activeCp.baseUrl, "GET", `/api/v1/orbs/${orbId}`);
        const history = await api(activeCp.baseUrl, "GET", `/api/v1/orbs/${orbId}/history`);
        const records = history.body["records"] as {
          id: string;
          eventType?: string;
          alert?: { message: string; requestId: string };
          content?: unknown;
        }[];
        const alert = records.find(
          (record) => record.alert?.message === message && record.alert.requestId === requestId,
        );
        if (alert === undefined || view.body["unreadAlertId"] !== alert.id) return null;
        return alert.id;
      },
      { timeoutMs: 120_000, intervalMs: 500 },
    );
    const executablePath =
      process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] ??
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    const browser = await chromium.launch({
      ...(executablePath === undefined ? {} : { executablePath }),
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      try {
        await page.goto(`${cp.baseUrl}/#/`);
        const entry = page.locator(".orb-entry", {
          has: page.locator(`a[href="#/orbs/${orbId}"]`),
        });
        await expectPage(entry.locator('img[src="/favicons/alert.svg"]')).toHaveCount(1);
        await entry.getByRole("link").first().click();
        await expectPage(page.locator(".rec-alert")).toContainText(message);
        await expectPage
          .poll(
            async () =>
              (await api(activeCp.baseUrl, "GET", `/api/v1/orbs/${orbId}`)).body["unreadAlertId"] ??
              null,
          )
          .toBeNull();
        await page.reload();
        await expectPage(page.locator(".rec-alert")).toContainText(message);
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }
    await waitFor(
      "tool turn completed",
      async () => {
        const history = await api(activeCp.baseUrl, "GET", `/api/v1/orbs/${orbId}/history`);
        return JSON.stringify(history.body["records"]).includes("ALERT_TOOL_COMPLETED")
          ? true
          : null;
      },
      { timeoutMs: 120_000, intervalMs: 500 },
    );
    const history = await api(cp.baseUrl, "GET", `/api/v1/orbs/${orbId}/history`);
    const records = history.body["records"] as { id: string; alert?: { message: string } }[];
    expect(
      records.filter((record) => record.id === alertId && record.alert?.message === message),
    ).toHaveLength(1);
    expect(records.filter((record) => record.alert?.message === message)).toHaveLength(1);
    const requests = (await fakeControl(fake.sessionKey, "/requests")) as unknown as unknown[];
    const turns = newModelRequestsById(requests, before).filter(
      (request) =>
        !JSON.stringify(request.body).includes(
          "Write a single short desktop-notification sentence",
        ),
    );
    expect(turns).toHaveLength(2); // Tool call and its normal completion; the alert itself adds none.
  } catch (error) {
    failure = error;
    const evidence = join(import.meta.dirname, "../.context/orb-alerts/evidence", randomUUID());
    mkdirSync(evidence, { recursive: true });
    writeFileSync(
      join(evidence, "failure.txt"),
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    if (cp !== undefined) {
      writeFileSync(join(evidence, "control-plane.log"), cp.logs.join(""));
      for (const [name, path] of [
        ["orb.json", `/api/v1/orbs/${orbId}`],
        ["history.json", `/api/v1/orbs/${orbId}/history`],
      ] as const) {
        const result = await api(cp.baseUrl, "GET", path).catch((diagnostic: unknown) => ({
          diagnostic: String(diagnostic),
        }));
        writeFileSync(join(evidence, name), JSON.stringify(result, null, 2));
      }
    }
    if (fake !== undefined)
      writeFileSync(
        join(evidence, "requests.json"),
        JSON.stringify(await fakeControl(fake.sessionKey, "/requests").catch(String), null, 2),
      );
    if (existsSync(join(root, "hosts", orbId)))
      cpSync(join(root, "hosts", orbId), join(evidence, "host"), { recursive: true });
    console.error(`orb-alerts E2E evidence: ${evidence}`);
  } finally {
    const cleanup = await Promise.allSettled([
      cp?.stop() ?? Promise.resolve(),
      fake === undefined ? Promise.resolve() : deleteFakeSession(fake.sessionKey),
      nameFake === undefined ? Promise.resolve() : deleteFakeSession(nameFake.sessionKey),
    ]);
    rmSync(root, { recursive: true, force: true });
    if (failure === undefined)
      for (const result of cleanup) if (result.status === "rejected") failure = result.reason;
  }
  if (failure !== undefined) throw failure;
});
