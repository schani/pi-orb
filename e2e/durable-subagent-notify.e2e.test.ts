import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_SUBPROTOCOL, type ServerFrame } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import WebSocket from "ws";
import {
  api,
  type ControlPlaneHandle,
  createFakeSession,
  deleteFakeSession,
  type FakeSession,
  FatalProbeError,
  fakeControl,
  readReplicatedHistorySnapshot,
  startControlPlane,
  waitFor,
} from "./harness.ts";
import {
  latestUserMessage,
  onlyCodemodeCatalog,
  requestedTools,
} from "./testkit/durable-model-fixture.ts";

const stop = { type: "stop", status: "completed" } as const;

it.runIf(process.env["PI_ORB_E2E_BACKEND"] === "process")(
  "central child alert interrupts a normal codemode wait privately; root escalation stays public",
  async () => {
    const runId = randomUUID();
    const root = mkdtempSync(join(tmpdir(), "pi-orb-subagent-notify-"));
    const project = randomUUID();
    const orb = randomUUID();
    const frames: ServerFrame[] = [];
    let cp: ControlPlaneHandle | undefined;
    let fake: FakeSession | undefined;
    let nameFake: FakeSession | undefined;
    let socket: WebSocket | undefined;
    let failed = true;
    try {
      fake = await createFakeSession(
        `subagent-notify-${runId}`,
        {
          auth: { accountId: "subagent-notify", device: { manualApprove: true } },
          model: {
            rules: [
              {
                match: { userMessage: { regex: "^NOTIFY_START$" } },
                steps: [
                  {
                    type: "toolCall",
                    name: "codemode",
                    arguments: {
                      code: `
text(await tools.bash({command:'mkfifo notify-spawn-release notify-alert-release notify-child-release notify-parent-release'}));
const child = JSON.parse(await tools.subagent({prompt:'NOTIFY_CHILD',description:'notification sender'}));
store('notify-child', child.agent_id);
text(await tools.bash({command:'read value < notify-spawn-release'}));
text('NOTIFY_SPAWNED');`,
                    },
                  },
                  stop,
                ],
              },
              {
                match: { userMessage: { regex: "^NOTIFY_CHILD$" } },
                steps: [
                  {
                    type: "toolCall",
                    name: "codemode",
                    arguments: {
                      code: `
text(await tools.bash({command:'printf ready > notify-child-ready; read value < notify-alert-release'}));
text(await tools.orb_alert({message:'PRIVATE_CHILD_COORDINATION'}));
text(await tools.bash({command:'printf accepted > notify-alert-accepted; read value < notify-child-release'}));
text('NOTIFY_CHILD_FINISHED');`,
                    },
                  },
                  stop,
                ],
              },
              {
                match: { toolResultContains: { regex: "NOTIFY_SPAWNED" } },
                steps: [
                  {
                    type: "toolCall",
                    name: "codemode",
                    arguments: {
                      code: `
text(await tools.get_subagent_result({agent_id:load('notify-child'),wait:true}));
text('NOTIFY_WAIT_CONTINUED');`,
                    },
                  },
                  stop,
                ],
              },
              {
                match: { userMessage: { regex: "PRIVATE_CHILD_COORDINATION" } },
                steps: [
                  {
                    type: "toolCall",
                    name: "codemode",
                    arguments: {
                      code: `
text(await tools.bash({command:'printf received > notify-parent-received; read value < notify-parent-release'}));
text(await tools.get_subagent_result({agent_id:load('notify-child'),wait:true}));
text('NOTIFY_PARENT_HANDLED');`,
                    },
                  },
                  stop,
                ],
              },
              {
                match: { toolResultContains: { regex: "NOTIFY_CHILD_FINISHED" } },
                steps: [{ type: "text", content: "NOTIFY_CHILD_RECEIPT" }, stop],
              },
              {
                match: { toolResultContains: { regex: "NOTIFY_PARENT_HANDLED" } },
                steps: [{ type: "text", content: "NOTIFY_PARENT_DONE" }, stop],
              },
              {
                match: {
                  userMessage: { regex: "^Write a single short desktop-notification sentence" },
                },
                steps: [{ type: "text", content: "Handled child coordination." }, stop],
              },
              {
                match: { userMessage: { regex: "^NOTIFY_ESCALATE$" } },
                steps: [
                  {
                    type: "toolCall",
                    name: "codemode",
                    arguments: {
                      code: "text(await tools.orb_alert({message:'ROOT_PUBLIC_ESCALATION'})); text('NOTIFY_ESCALATED');",
                    },
                  },
                  stop,
                ],
              },
              {
                match: { toolResultContains: { regex: "NOTIFY_ESCALATED" } },
                steps: [{ type: "text", content: "NOTIFY_ESCALATION_DONE" }, stop],
              },
              {
                match: {
                  userMessage: { regex: "^Write a single short desktop-notification sentence" },
                },
                steps: [{ type: "text", content: "Escalated to the user." }, stop],
              },
              {
                match: { default: true },
                steps: [{ type: "text", content: "NOTIFY_UNEXPECTED_REQUEST" }, stop],
              },
            ],
          },
        },
        "central-durable",
      );
      nameFake = await createFakeSession(
        `subagent-notify-names-${runId}`,
        {
          model: {
            rules: [
              { match: { default: true }, steps: [{ type: "text", content: "Notify" }, stop] },
            ],
          },
        },
        "central-durable",
      );
      cp = await startControlPlane({
        port: 7284,
        fake,
        nameFake,
        agentBackend: "central-durable",
        pglitePath: join(root, "db"),
        authDir: join(root, "auth"),
        hostingRoot: join(root, "hosting"),
        processStateDirectory: join(root, "hosts"),
        durableStateDirectory: join(root, "authority"),
        extraEnv: { PI_ORB_E2E_HISTORY_INSPECTION: "1" },
      });
      const active = cp;
      const view = async () => (await api(active.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body;
      const history = async () => readReplicatedHistorySnapshot(active, orb);
      const send = async (text: string) => {
        expect(
          (
            await api(active.baseUrl, "PUT", `/api/v1/orbs/${orb}/messages/${randomUUID()}`, {
              content: [{ type: "text", text }],
            })
          ).status,
        ).toBe(202);
      };
      expect(
        (
          await api(cp.baseUrl, "POST", "/api/v1/projects", {
            id: project,
            name: "Subagent notifications",
            repositoryUrl: "https://github.com/schani/pi-orb",
          })
        ).status,
      ).toBe(201);
      expect(
        (await api(cp.baseUrl, "POST", `/api/v1/projects/${project}/orbs`, { id: orb })).status,
      ).toBe(202);
      const code = await waitFor("notification fixture login", async () => {
        const action = (await view())["actionRequired"] as { userCode?: string } | undefined;
        return action?.userCode || null;
      });
      await fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: code });
      await waitFor(
        "notification process host ready",
        async () => {
          const current = await view();
          if (current["state"] === "failed") throw new FatalProbeError(JSON.stringify(current));
          return current["state"] === "running" ? true : null;
        },
        { timeoutMs: 300_000 },
      );

      socket = new WebSocket(`${cp.baseUrl.replace(/^http/, "ws")}/api/v1/orbs/${orb}/live`, [
        RUNTIME_SUBPROTOCOL,
      ]);
      const live = socket;
      live.on("message", (data) => frames.push(JSON.parse(data.toString()) as ServerFrame));
      live.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        live.once("open", resolve);
        live.once("error", reject);
      });
      live.send(
        JSON.stringify({
          v: 1,
          type: "client.hello",
          clientInstanceId: randomUUID(),
          afterRecordId: null,
        }),
      );
      await waitFor("notification live sync", async () =>
        frames.some((frame) => frame.type === "sync.completed") ? true : null,
      );
      await send("NOTIFY_START");
      const checkout = join(root, "hosts", orb, "workspace", "repo");
      await waitFor("child alert gate owned by execution host", async () =>
        existsSync(join(checkout, "notify-child-ready")) ? true : null,
      );
      // The fake consumes one global ordered rule stream. Gate parent inference
      // until the child's first response has reached the execution host.
      await writeFile(join(checkout, "notify-spawn-release"), "release\n");
      // The second root call contains only the normal wait and its continuation.
      // Child completion stays gated even after its alert is admitted.
      await waitFor("parent wait codemode running", async () => {
        const calls = new Set(
          frames.flatMap((frame) =>
            frame.type === "runtime.event" &&
            frame.event.type === "tool_state" &&
            frame.event.name === "codemode" &&
            frame.event.state === "running"
              ? [frame.event.callId]
              : [],
          ),
        );
        return calls.size === 2 ? true : null;
      });
      await writeFile(join(checkout, "notify-alert-release"), "release\n");
      await waitFor("child private alert accepted", async () =>
        existsSync(join(checkout, "notify-alert-accepted")) ? true : null,
      );
      await waitFor("parent receives child coordination before child completion", async () =>
        existsSync(join(checkout, "notify-parent-received")) ? true : null,
      );

      const privateHistory = await waitFor("parent coordination call replicated", async () => {
        const snapshot = await history();
        return JSON.stringify(snapshot).includes("notify-parent-received") ? snapshot : null;
      });
      writeFileSync(join(root, "private-history.json"), JSON.stringify(privateHistory, null, 2));
      const transcript = JSON.stringify(privateHistory);
      expect(transcript).toContain("NOTIFY_WAIT_CONTINUED");
      expect(transcript).toContain('\\"status\\":\\"running\\"');
      expect(transcript).toContain('\\"interrupted\\":\\"parent_input\\"');
      expect(transcript).not.toContain("PRIVATE_CHILD_COORDINATION");
      expect(
        privateHistory.records.filter(
          (record) => record.type === "event" && record.eventType === "orb.alert",
        ),
      ).toEqual([]);
      expect(
        privateHistory.records.filter(
          (record) => record.type === "message" && record.role === "user",
        ),
      ).toHaveLength(1);
      expect((await view())["unreadAlertId"]).toBeUndefined();
      const notification = cp.modelRequests?.find((request) =>
        latestUserMessage(request)?.includes("PRIVATE_CHILD_COORDINATION"),
      );
      expect(notification).toBeDefined();
      expect(JSON.parse(latestUserMessage(notification) ?? "null")).toMatchObject({
        agent_id: expect.any(String),
        description: "notification sender",
        message: "PRIVATE_CHILD_COORDINATION",
      });
      expect(onlyCodemodeCatalog(notification)).toBe(true);

      // Release only after proving the parent handled the alert with a live child.
      await writeFile(join(checkout, "notify-child-release"), "release\n");
      await writeFile(join(checkout, "notify-parent-release"), "release\n");
      await waitFor("parent notification response committed", async () =>
        JSON.stringify(await history()).includes("NOTIFY_PARENT_DONE") ? true : null,
      );
      await waitFor("notification turn summary settled", async () =>
        active.logs.join("").includes("harness.summary_completed") ? true : null,
      );
      expect(JSON.stringify(await history())).toContain("NOTIFY_CHILD_RECEIPT");
      await waitFor("notification work idle", async () =>
        (await view())["activity"] === "idle" ? true : null,
      );
      await send("NOTIFY_ESCALATE");
      const escalated = await waitFor("root alert public and unread", async () => {
        const snapshot = await history();
        const alert = snapshot.records.find(
          (record) => record.type === "event" && record.eventType === "orb.alert",
        );
        return alert &&
          (await view())["unreadAlertId"] === alert.id &&
          JSON.stringify(snapshot).includes("NOTIFY_ESCALATION_DONE")
          ? snapshot
          : null;
      });
      expect(
        escalated.records.filter(
          (record) => record.type === "event" && record.eventType === "orb.alert",
        ),
      ).toMatchObject([{ alert: { message: "ROOT_PUBLIC_ESCALATION" } }]);
      await waitFor("escalation turn summary settled", async () =>
        active.logs.join("").split("harness.summary_completed").length === 3 ? true : null,
      );
      expect(JSON.stringify(escalated)).not.toContain("PRIVATE_CHILD_COORDINATION");
      expect(JSON.stringify(frames)).not.toContain("PRIVATE_CHILD_COORDINATION");
      expect((await api(cp.baseUrl, "POST", `/api/v1/orbs/${orb}/stop`)).status).toBe(202);
      await waitFor("notification orb stopped", async () =>
        (await view())["state"] === "stopped" ? true : null,
      );
      expect((await api(cp.baseUrl, "POST", `/api/v1/orbs/${orb}/start`)).status).toBe(202);
      await waitFor(
        "native notification history reopened",
        async () => {
          const current = await view();
          if (current["state"] === "failed") throw new FatalProbeError(JSON.stringify(current));
          return current["state"] === "running" ? true : null;
        },
        { timeoutMs: 300_000 },
      );
      const reopened = await history();
      expect(reopened.records.slice(0, escalated.records.length)).toEqual(escalated.records);
      expect(reopened.session).toEqual(escalated.session);
      expect(JSON.stringify(reopened)).not.toContain("PRIVATE_CHILD_COORDINATION");
      const catalogs = cp.modelRequests?.filter((request) => requestedTools(request).length > 0);
      expect(catalogs?.length).toBeGreaterThan(3);
      expect(catalogs?.every(onlyCodemodeCatalog)).toBe(true);
      failed = false;
    } catch (error) {
      writeFileSync(join(root, "failure.txt"), String(error));
      throw error;
    } finally {
      socket?.terminate();
      if (cp) {
        await cp.stop();
        writeFileSync(join(root, "control-plane.log"), cp.logs.join(""));
        writeFileSync(
          join(root, "original-model-requests.json"),
          JSON.stringify(cp.modelRequests, null, 2),
        );
      }
      if (fake) {
        writeFileSync(
          join(root, "model-requests.json"),
          JSON.stringify(await fakeControl(fake.sessionKey, "/requests"), null, 2),
        );
        await deleteFakeSession(fake.sessionKey);
      }
      if (nameFake) await deleteFakeSession(nameFake.sessionKey);
      writeFileSync(join(root, "frames.json"), JSON.stringify(frames, null, 2));
      if (failed) {
        const evidence = join(
          import.meta.dirname,
          "../test-failures",
          `durable-subagent-notify-${runId}`,
        );
        mkdirSync(evidence, { recursive: true });
        cpSync(root, evidence, { recursive: true });
        console.error(`Subagent notification E2E evidence: ${evidence}`);
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
