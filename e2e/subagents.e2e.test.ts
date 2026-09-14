import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect as expectPage } from "@playwright/test";
import { build } from "vite";
import { expect, it } from "vitest";
import { DEFAULT_LIFECYCLE_CONSTANTS } from "../apps/control-plane/src/domain/constants.ts";
import {
  api,
  createFakeSession,
  deleteFakeSession,
  FatalProbeError,
  fakeControl,
  startControlPlane,
  waitFor,
} from "./harness.ts";

it("keeps delegated work busy through abort, crash recovery and active-child archival without private replication", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-subagents-e2e-"));
  for (const i of [0, 1, 2, 3])
    for (const gate of ["ready", "release"]) execFileSync("mkfifo", [join(root, `${gate}-${i}`)]);
  const stop = { type: "stop", status: "completed" };
  const rulesFor = (i: number) => [
    {
      match: { userMessage: { regex: `^SUBAGENT_E2E_${i}$` } },
      steps: [
        {
          type: "toolCall",
          name: "subagent",
          arguments: {
            prompt: `LEAF_E2E_${i}`,
            description: "Controlled editing leaf",
            subagent_type: "general-purpose",
            run_in_background: true,
          },
        },
        {
          type: "toolCall",
          name: "bash",
          arguments: { command: `read -r ready < '${root}/ready-${i}'; echo PARENT_READY_${i}` },
        },
        stop,
      ],
    },
    {
      match: { userMessage: { regex: `LEAF_E2E_${i}` } },
      steps: [
        ...(i === 2 ? [{ type: "text", content: "PRIVATE_CHILD_TRANSCRIPT_ONLY" }] : []),
        {
          type: "toolCall",
          name: "write",
          arguments: {
            path: i === 2 ? "child-edited.txt" : `${root}/edited-${i}`,
            content: "CHILD_EDIT_OK",
          },
        },
        ...(i === 2
          ? [
              // No detached subprocess survives the crash: write/read block on
              // owned FIFOs inside the child SDK's process, not a shell process.
              {
                type: "toolCall",
                name: "write",
                arguments: { path: `${root}/ready-${i}`, content: "ready\n" },
              },
              { type: "toolCall", name: "read", arguments: { path: `${root}/release-${i}` } },
            ]
          : [
              {
                type: "toolCall",
                name: "bash",
                arguments: {
                  command: `printf 'ready\\n' > '${root}/ready-${i}'; read -r release < '${root}/release-${i}'; echo CHILD_DONE_${i}`,
                },
              },
            ]),
        stop,
      ],
    },
    {
      match: { toolResultContains: { regex: `PARENT_READY_${i}` } },
      steps: [{ type: "text", content: `PARENT_SETTLED_${i}` }, stop],
    },
    ...(i === 0
      ? [
          {
            match: { toolResultContains: { regex: "CHILD_DONE_0" } },
            steps: [{ type: "text", content: "LEAF_FINISHED" }, stop],
          },
          {
            match: { userMessage: { regex: "task-notification" } },
            steps: [{ type: "text", content: "DELEGATION_COMPLETE" }, stop],
          },
          {
            match: {
              userMessage: { regex: "^Write a single short desktop-notification sentence" },
            },
            steps: [{ type: "text", content: "Completed delegated work." }, stop],
          },
        ]
      : []),
  ];
  const rules = [0, 1, 2].flatMap(rulesFor);
  rules.push(
    {
      match: { userMessage: { regex: "Local subagent runs .* were interrupted" } },
      steps: [{ type: "text", content: "CHILD_INTERRUPTION_ACKNOWLEDGED" }, stop],
    },
    {
      match: { userMessage: { regex: "^The agent runtime was restarted" } },
      steps: [{ type: "text", content: "SECOND_RESTART_COMPLETE" }, stop],
    },
    {
      match: { userMessage: { regex: "^The agent runtime was restarted" } },
      steps: [{ type: "text", content: "THIRD_RESTART_COMPLETE" }, stop],
    },
    ...rulesFor(3),
    {
      match: { toolResultContains: { regex: "CHILD_DONE_3" } },
      steps: [{ type: "text", content: "ARCHIVE_LEAF_FINISHED" }, stop],
    },
    {
      match: { userMessage: { regex: "task-notification" } },
      steps: [{ type: "text", content: "ARCHIVE_DELEGATION_COMPLETE" }, stop],
    },
    {
      match: { userMessage: { regex: "^Write a single short desktop-notification sentence" } },
      steps: [{ type: "text", content: "Completed archived delegation." }, stop],
    },
  );
  const fake = await createFakeSession(`subagents-${randomUUID()}`, {
    auth: { accountId: "subagents-test", device: { manualApprove: true } },
    model: { rules },
  });
  const names = await createFakeSession(`subagents-names-${randomUUID()}`, {
    model: {
      rules: [
        { match: { default: true }, steps: [{ type: "text", content: "Subagent test" }, stop] },
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
  const cp = await startControlPlane({
    port: 7173,
    fake,
    nameFake: names,
    pglitePath: join(root, "db"),
    processStateDirectory: join(root, "hosts"),
    webDist: join(root, "web"),
  });
  const browser = await chromium.launch({
    ...(existsSync("/usr/bin/chromium") ? { executablePath: "/usr/bin/chromium" } : {}),
    args: ["--no-sandbox"],
  });
  const project = randomUUID(),
    orb = randomUUID();
  let failed = false;
  try {
    expect(
      (
        await api(cp.baseUrl, "POST", "/api/v1/projects", {
          id: project,
          name: "Subagent test",
          repositoryUrl: "https://github.com/schani/pi-orb",
        })
      ).status,
    ).toBe(201);
    expect(
      (await api(cp.baseUrl, "POST", `/api/v1/projects/${project}/orbs`, { id: orb })).status,
    ).toBe(202);
    const code = await waitFor(
      "subagent login",
      async () => {
        const view = await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}`);
        return (view.body["actionRequired"] as { userCode?: string } | undefined)?.userCode ?? null;
      },
      { timeoutMs: 60_000 },
    );
    await fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: code });
    await waitFor(
      "subagent runtime ready",
      async () => {
        const view = await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}`);
        if (view.body["state"] === "failed") throw new FatalProbeError(JSON.stringify(view.body));
        return view.body["state"] === "running" ? true : null;
      },
      { timeoutMs: 300_000 },
    );
    const page = await browser.newPage();
    await page.goto(`${cp.baseUrl}/#/orbs/${orb}`);
    const workspace = join(root, "hosts", orb, "workspace");
    const rootEntries = (): {
      type: string;
      customType?: string;
      data?: Record<string, unknown>;
      details?: Record<string, unknown>;
    }[] => {
      const directory = join(workspace, "pi-sessions");
      const file = readdirSync(directory).find((name) => name.endsWith(".jsonl"));
      if (file === undefined) throw new FatalProbeError("root session file is missing");
      return readFileSync(join(directory, file), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    };
    const crashRuntime = (): void => {
      const metadata = JSON.parse(readFileSync(join(root, "hosts", orb, "host.json"), "utf8")) as {
        processGroupId: number | null;
      };
      if (metadata.processGroupId === null || metadata.processGroupId <= 0)
        throw new FatalProbeError("fixture runtime has no owned process");
      // Kill only this fixture's runtime. The process provider owns its relaunch.
      process.kill(metadata.processGroupId, "SIGKILL");
    };
    for (const i of [0, 1, 2]) {
      expect(
        (
          await api(cp.baseUrl, "PUT", `/api/v1/orbs/${orb}/messages/${randomUUID()}`, {
            content: [{ type: "text", text: `SUBAGENT_E2E_${i}` }],
          })
        ).status,
      ).toBe(202);
      await expectPage(page.getByText(`PARENT_SETTLED_${i}`, { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expectPage(page.getByRole("button", { name: "abort", exact: true })).toBeVisible();
      await expectPage(page.locator(".orb-life")).toContainText("busy", { timeout: 30_000 });
      expect(
        readFileSync(
          i === 2 ? join(workspace, "repo", "child-edited.txt") : `${root}/edited-${i}`,
          "utf8",
        ),
      ).toBe("CHILD_EDIT_OK");
      // Reload while only a child is working: exercise the real sync handshake.
      await page.reload();
      await expectPage(page.getByRole("button", { name: "abort", exact: true })).toBeVisible({
        timeout: 30_000,
      });
      if (i === 0) {
        await writeFile(`${root}/release-${i}`, "release\n");
        await expectPage(page.getByText("DELEGATION_COMPLETE", { exact: true })).toBeVisible({
          timeout: 60_000,
        });
        await waitFor(
          "aggregate summary rule consumed",
          async () => {
            const requests = (await fakeControl(fake.sessionKey, "/requests")) as unknown as {
              matchedRuleIndex?: number;
              status?: number;
            }[];
            return requests.some((r) => r.matchedRuleIndex === 5 && r.status === 200) ? true : null;
          },
          { timeoutMs: 60_000 },
        );
      } else if (i === 1) {
        await page.getByRole("button", { name: "abort", exact: true }).click();
        await expectPage(page.getByText("Cancelling delegated work.", { exact: true })).toBeVisible(
          { timeout: 30_000 },
        );
      } else {
        const admission = rootEntries()
          .filter((e) => e.customType === "pi-orb.subagent-run" && e.data?.["phase"] === "admitted")
          .at(-1);
        const childId = admission?.data?.["childId"];
        expect(typeof childId).toBe("string");
        crashRuntime();
        await expectPage(
          page.getByText("CHILD_INTERRUPTION_ACKNOWLEDGED", { exact: true }),
        ).toBeVisible({ timeout: 60_000 });
        await expectPage(page.getByRole("button", { name: "abort", exact: true })).toHaveCount(0, {
          timeout: 30_000,
        });
        expect(
          rootEntries().filter((e) => Array.isArray(e.details?.["interruptedSubagents"])),
        ).toHaveLength(1);
        expect(
          JSON.stringify(
            rootEntries().find((e) => Array.isArray(e.details?.["interruptedSubagents"]))?.details,
          ),
        ).toContain(String(childId));
        // An acknowledged interruption is not counted again on another boot.
        crashRuntime();
        await expectPage(page.getByText("SECOND_RESTART_COMPLETE", { exact: true })).toBeVisible({
          timeout: 60_000,
        });
        expect(
          rootEntries().filter((e) => Array.isArray(e.details?.["interruptedSubagents"])),
        ).toHaveLength(1);
        expect(
          rootEntries().filter(
            (e) => e.customType === "pi-orb.subagent-run" && e.data?.["phase"] === "admitted",
          ),
        ).toHaveLength(3);
      }
      await expectPage(page.getByRole("button", { name: "abort", exact: true })).toHaveCount(0, {
        timeout: 60_000,
      });
      await waitFor(
        "replicated aggregate idle and child result",
        async () => {
          const view = await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}`);
          const history = await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}/history`);
          return view.body["activity"] === "idle" &&
            JSON.stringify(history.body).includes(
              i === 0
                ? "DELEGATION_COMPLETE"
                : i === 1
                  ? "wake_suppressed"
                  : "SECOND_RESTART_COMPLETE",
            )
            ? true
            : null;
        },
        { timeoutMs: 60_000 },
      );
    }
    // Whole-operation abort is fenced before terminal delivery; no third root response.
    const requests = (await fakeControl(fake.sessionKey, "/requests")) as unknown as {
      surface: string;
      status: number;
    }[];
    // Device-code polling may legitimately be pending before approval. Only
    // model calls prove (or violate) cancellation's no-inference guarantee.
    const modelRequests = requests.filter((r) => r.surface === "model");
    expect(modelRequests).toHaveLength(14);
    expect(modelRequests.every((r) => r.status === 200)).toBe(true);
    expect((await api(cp.baseUrl, "POST", `/api/v1/orbs/${orb}/stop`)).status).toBe(202);
    await waitFor(
      "stopped subagent root history",
      async () =>
        (await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["state"] === "stopped"
          ? true
          : null,
      { timeoutMs: 60_000 },
    );
    expect(
      JSON.stringify((await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}/history`)).body),
    ).toContain("DELEGATION_COMPLETE");
    const replicated = JSON.stringify(
      (await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}/history`)).body,
    );
    expect(replicated).toContain("interruptedSubagents");
    expect(replicated).not.toContain("PRIVATE_CHILD_TRANSCRIPT_ONLY");
    // Resume the retained workspace, then archive with an actually blocked child.
    expect((await api(cp.baseUrl, "POST", `/api/v1/orbs/${orb}/start`)).status).toBe(202);
    await waitFor(
      "resume before active archive",
      async () =>
        (await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["state"] === "running"
          ? true
          : null,
      { timeoutMs: 300_000 },
    );
    await page.reload();
    await expectPage(page.getByText("THIRD_RESTART_COMPLETE", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    expect(
      (
        await api(cp.baseUrl, "PUT", `/api/v1/orbs/${orb}/messages/${randomUUID()}`, {
          content: [{ type: "text", text: "SUBAGENT_E2E_3" }],
        })
      ).status,
    ).toBe(202);
    await expectPage(page.getByText("PARENT_SETTLED_3", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expectPage(page.locator(".orb-life")).toContainText("busy", { timeout: 30_000 });
    const archiveChildId = rootEntries()
      .filter(
        (entry) =>
          entry.customType === "pi-orb.subagent-run" && entry.data?.["phase"] === "admitted",
      )
      .at(-1)?.data?.["childId"];
    expect(typeof archiveChildId).toBe("string");
    expect((await api(cp.baseUrl, "POST", `/api/v1/orbs/${orb}/archive`)).status).toBe(202);
    await waitFor(
      "archive explicitly declines preparation while the child owns work",
      async () =>
        cp.logs.join("").includes(`lifecycle: orb=${orb} archive-waiting-for-work`) ? true : null,
      { timeoutMs: 60_000 },
    );
    expect(cp.logs.join("")).not.toContain(`lifecycle: orb=${orb} archive-history-sealed`);
    expect(existsSync(workspace)).toBe(true);
    expect(
      rootEntries().some(
        (entry) =>
          entry.customType === "subagents:record" &&
          entry.data?.["id"] === archiveChildId &&
          entry.data?.["status"] === "completed",
      ),
    ).toBe(false);
    await writeFile(`${root}/release-3`, "release\n");
    await waitFor(
      "archive seals root history and removes child workspace",
      async () =>
        (await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["state"] === "archived"
          ? true
          : null,
      // The first run's 60s watchdog was shorter than the mandatory 65s
      // quarantine, independently of child work. Budget that policy explicitly.
      { timeoutMs: DEFAULT_LIFECYCLE_CONSTANTS.deletionQuarantineMs + 60_000 },
    );
    expect(existsSync(workspace)).toBe(false);
    const archivedHistory = (await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}/history`)).body;
    const archivedRecords = archivedHistory["records"] as {
      overflow?: { native?: { customType?: string; data?: Record<string, unknown> } };
    }[];
    expect(
      archivedRecords.filter(
        (record) =>
          record.overflow?.native?.customType === "subagents:record" &&
          record.overflow.native.data?.["id"] === archiveChildId &&
          record.overflow.native.data?.["status"] === "completed",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(archivedHistory)).toContain("idle-stop-prepared");
    expect(JSON.stringify(archivedHistory)).toContain("ARCHIVE_DELEGATION_COMPLETE");
    expect(JSON.stringify(archivedHistory)).not.toContain("PRIVATE_CHILD_TRANSCRIPT_ONLY");
    expect(
      JSON.stringify((await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}/history`)).body),
    ).toContain("interruptedSubagents");
  } catch (error) {
    failed = true;
    console.error(`Preserved runtime files: ${root}`);
    console.error(
      JSON.stringify((await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}/history`)).body),
    );
    console.error(cp.logs.join(""));
    const requests = (await fakeControl(fake.sessionKey, "/requests")) as unknown as {
      surface: string;
      status: number;
      matchedRuleIndex: number | null;
      stopReason: string | null;
      aborted: boolean;
      finalized: boolean;
    }[];
    console.error(
      JSON.stringify(
        requests.map(({ surface, status, matchedRuleIndex, stopReason, aborted, finalized }) => ({
          surface,
          status,
          matchedRuleIndex,
          stopReason,
          aborted,
          finalized,
        })),
      ),
    );
    throw error;
  } finally {
    await browser.close();
    await cp.stop();
    await deleteFakeSession(fake.sessionKey);
    await deleteFakeSession(names.sessionKey);
    if (!failed) rmSync(root, { recursive: true, force: true });
  }
}, 480_000);
