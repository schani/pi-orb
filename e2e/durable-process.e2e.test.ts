import { execFileSync } from "node:child_process";
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
import { writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  capHeadline,
  DisplayHistoryViewSchema,
  type DisplayRecord,
  RUNTIME_SUBPROTOCOL,
  type ServerFrame,
} from "@pi-orb/protocol";
import { type Browser, chromium, expect as expectPage } from "@playwright/test";
import { Check } from "typebox/value";
import { build } from "vite";
import { expect, it } from "vitest";
import WebSocket from "ws";
import {
  api,
  createFakeSession,
  deleteFakeSession,
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
import { committedToolOutput } from "./testkit/durable-wait-barriers.ts";

const message =
  "PRIVATE_CHILD_COORDINATION  <b>literal</b>\n" + "😀".repeat(500) + "\nDETAIL_ONLY_TAIL";
const messagePreview = capHeadline(message.replace(/\s+/gu, " ").trim());

const codemode = (code: string) => ({
  type: "toolCall",
  name: "codemode",
  arguments: { code },
});

function loginCode(body: Record<string, unknown>): string | null {
  const action = body["actionRequired"] as
    | { type?: string; userCode?: string; verificationUri?: string }
    | undefined;
  return action?.type === "openai_codex_device_login" && action.userCode && action.verificationUri
    ? action.userCode
    : null;
}

it("waits for a published Codex challenge, not the pending empty placeholder", () => {
  expect(
    loginCode({
      actionRequired: { type: "openai_codex_device_login", userCode: "", verificationUri: "" },
    }),
  ).toBeNull();
  expect(
    loginCode({
      actionRequired: {
        type: "github_device_login",
        userCode: "GITHUB",
        verificationUri: "https://github.com/login/device",
      },
    }),
  ).toBeNull();
  expect(
    loginCode({
      actionRequired: {
        type: "openai_codex_device_login",
        userCode: "usercode_2",
        verificationUri: "https://auth.test/device",
      },
    }),
  ).toBe("usercode_2");
});

it.runIf(process.env["PI_ORB_E2E_BACKEND"] === "process")(
  "central Durable owns inference/history while process host executes filesystem and shell",
  async () => {
    const runId = randomUUID();
    const root = mkdtempSync(join(tmpdir(), "pi-orb-durable-process-"));
    let failed = true;
    const frames: ServerFrame[] = [];
    let socket: WebSocket | undefined;
    const stop = { type: "stop", status: "completed" };
    const key = join(root, "key.pem"),
      cert = join(root, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-subj",
        "/CN=durable-fixture",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-days",
        "1",
      ],
      { stdio: "ignore" },
    );
    const calls: { method: string; authorization: string | undefined }[] = [];
    const remote = createServer(
      { key: readFileSync(key), cert: readFileSync(cert) },
      async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const message = JSON.parse(body);
        calls.push({ method: message.method, authorization: req.headers.authorization });
        if (req.headers.authorization !== "Bearer synthetic-durable") {
          res.writeHead(401).end();
          return;
        }
        if (message.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        const results: Record<string, unknown> = {
          initialize: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          },
          "tools/list": {
            tools: [
              {
                name: "echo",
                inputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
            ],
          },
          "tools/call": {
            content: [{ type: "text", text: `MCP_CALL_OK:${message.params?.arguments?.value}` }],
          },
        };
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            ...(message.method in results
              ? { result: results[message.method] }
              : { error: { code: -32601, message: "unsupported" } }),
          }),
        );
      },
    );
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("missing MCP listener");
    const webRoot = join(import.meta.dirname, "../apps/web");
    await build({
      root: webRoot,
      configFile: join(webRoot, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir: join(root, "web"), emptyOutDir: true },
    });
    const script = `
const orbNamespace = await describeNamespace('orb');
if (!orbNamespace?.instructions || !orbNamespace.tools.includes('orb_self')) throw new Error('missing orb namespace');
text('ORB_NAMESPACE_OK');
text(await tools.mcp__fixture__echo({value:'root'}));
text(await tools.write({path:'durable-file.txt',content:'REMOTE_WRITE_OK'}));
text(await tools.read({path:'durable-file.txt'}));
text(await tools.bash({command:'mkfifo durable-child-release durable-parent-release; printf REMOTE_SHELL_OK'}));
const child = JSON.parse(await tools.subagent({prompt:'DURABLE_CHILD',description:'gated child'}));
text(await tools.bash({command:'read value < durable-parent-release'}));
text(await tools.steer_subagent({agent_id:child.agent_id,message:'DURABLE_STEER'}));
text(await tools.bash({command:'printf accepted > durable-steer-ready'}));
text(await tools.list_subagents({}));
text(await tools.get_subagent_result({agent_id:child.agent_id,wait:false}));
text(await tools.get_subagent_result({agent_id:child.agent_id,wait:true}));
const cancelled = JSON.parse(await tools.subagent({prompt:'DURABLE_CANCEL_CHILD'}));
text(await tools.cancel_subagent({agent_id:cancelled.agent_id}));
text(await tools.orb_self({}));
text(await tools.orb_alert({message:'DURABLE_NATIVE_ALERT'}));
text('DURABLE_SCRIPT_DONE');`;
    const fake = await createFakeSession(`durable-process-${randomUUID()}`, {
      auth: { accountId: "durable-process", device: { manualApprove: true } },
      model: {
        rules: [
          {
            match: { userMessage: { regex: "^DURABLE_REMOTE$" } },
            steps: [
              {
                type: "toolCall",
                name: "bash",
                arguments: {
                  command: "printf '%s' $$ > durable-shell-pid; printf 'REMOTE_SHELL_OK'",
                },
              },
              stop,
            ],
          },
          {
            match: { toolResultContains: { regex: "REMOTE_SHELL_OK" } },
            steps: [
              {
                type: "toolCall",
                name: "write",
                arguments: { path: "durable-file.txt", content: "REMOTE_WRITE_OK" },
              },
              stop,
            ],
          },
          {
            match: { toolResultContains: { regex: "Successfully wrote to durable-file.txt" } },
            steps: [{ type: "text", content: "DURABLE_REMOTE_DONE" }, stop],
          },
          {
            match: {
              userMessage: { regex: "^Write a single short desktop-notification sentence" },
            },
            steps: [{ type: "text", content: "Verified remote execution." }, stop],
          },
          {
            match: { userMessage: { regex: "^DURABLE_ACCEPTANCE$" } },
            steps: [{ type: "toolCall", name: "codemode", arguments: { code: script } }, stop],
          },
          {
            match: { userMessage: { regex: "^DURABLE_CHILD$" } },
            steps: [
              {
                type: "toolCall",
                name: "codemode",
                arguments: {
                  code: "await tools.mcp__fixture__echo({value:'CHILD_PRIVATE_MCP'}); text(await tools.bash({command:'printf ready > durable-child-ready; read value < durable-child-release; printf CHILD_RELEASED'}));",
                },
              },
              stop,
            ],
          },
          {
            match: { userMessage: { regex: "^DURABLE_STEER$" } },
            steps: [{ type: "text", content: "DURABLE_STEER_DONE" }, stop],
          },
          {
            match: { toolResultContains: { regex: "CHILD_RELEASED" } },
            steps: [{ type: "text", content: "DURABLE_CHILD_DONE" }, stop],
          },
          {
            match: { userMessage: { regex: "^DURABLE_CANCEL_CHILD$" } },
            steps: [
              {
                type: "toolCall",
                name: "bash",
                arguments: { command: "read value < durable-child-release" },
              },
              stop,
            ],
          },
          {
            match: { toolResultContains: { regex: "DURABLE_SCRIPT_DONE" } },
            steps: [{ type: "text", content: "DURABLE_ACCEPTANCE_DONE" }, stop],
          },
          {
            match: {
              userMessage: { regex: "^Write a single short desktop-notification sentence" },
            },
            steps: [{ type: "text", content: "Verified tools and child control." }, stop],
          },
          {
            match: { userMessage: { regex: "^NOTIFY_START$" } },
            steps: [
              codemode(`
text(await tools.bash({command:'mkfifo notify-spawn-release notify-alert-release notify-child-release notify-parent-release'}));
const child = JSON.parse(await tools.subagent({prompt:'NOTIFY_CHILD',description:'notification sender'}));
store('notify-child', child.agent_id);
text(child);
text(await tools.bash({command:'read value < notify-spawn-release'}));
text('NOTIFY_SPAWNED');`),
              stop,
            ],
          },
          {
            match: { userMessage: { regex: "^NOTIFY_CHILD$" } },
            steps: [
              codemode(`
text(await tools.bash({command:'printf ready > notify-child-ready; read value < notify-alert-release'}));
text(await tools.orb_alert({message:${JSON.stringify(message)}}));
text(await tools.bash({command:'printf accepted > notify-alert-accepted; read value < notify-child-release'}));
text('NOTIFY_CHILD_FINISHED');`),
              stop,
            ],
          },
          {
            match: { toolResultContains: { regex: "NOTIFY_SPAWNED" } },
            steps: [
              codemode(`
text(await tools.get_subagent_result({agent_id:load('notify-child'),wait:true}));
text('NOTIFY_WAIT_CONTINUED');`),
              stop,
            ],
          },
          {
            match: { userMessage: { regex: "PRIVATE_CHILD_COORDINATION" } },
            steps: [
              codemode(`
text(await tools.bash({command:'printf received > notify-parent-received; read value < notify-parent-release'}));
text(await tools.get_subagent_result({agent_id:load('notify-child'),wait:true}));
text('NOTIFY_PARENT_HANDLED');`),
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
              codemode(
                "text(await tools.orb_alert({message:'ROOT_PUBLIC_ESCALATION'})); text('NOTIFY_ESCALATED');",
              ),
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
            steps: [{ type: "text", content: "DURABLE_REMOTE_DONE" }, stop],
          },
        ],
      },
    });
    const nameFake = await createFakeSession(`durable-names-${randomUUID()}`, {
      model: {
        rules: [{ match: { default: true }, steps: [{ type: "text", content: "Durable" }, stop] }],
      },
    });
    let browser: Browser | undefined;
    let cp: Awaited<ReturnType<typeof startControlPlane>> | undefined;
    const project = randomUUID();
    const orb = randomUUID();
    try {
      cp = await startControlPlane({
        port: 7273,
        fake,
        pglitePath: join(root, "db"),
        authDir: join(root, "auth"),
        hostingRoot: join(root, "hosting"),
        processStateDirectory: join(root, "hosts"),
        durableStateDirectory: join(root, "authority"),
        nameFake,
        webDist: join(root, "web"),
        extraEnv: { NODE_EXTRA_CA_CERTS: cert, PI_ORB_E2E_HISTORY_INSPECTION: "1" },
      });
      expect(
        (
          await api(cp.baseUrl, "POST", "/api/v1/projects", {
            id: project,
            name: "Durable process",
            repositoryUrl: "https://github.com/schani/pi-orb",
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await api(cp.baseUrl, "PUT", `/api/v1/projects/${project}/secrets/MCP_KEY`, {
            value: "synthetic-durable",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await api(cp.baseUrl, "PUT", `/api/v1/projects/${project}/mcp`, {
            revision: 0,
            servers: [
              {
                name: "fixture",
                description: "Durable authenticated MCP fixture",
                url: `https://127.0.0.1:${address.port}/mcp`,
                headers: { Authorization: { secret: "MCP_KEY", prefix: "Bearer " } },
              },
            ],
          })
        ).status,
      ).toBe(200);
      expect(
        (await api(cp.baseUrl, "POST", `/api/v1/projects/${project}/orbs`, { id: orb })).status,
      ).toBe(202);
      const code = await waitFor(
        "central model login",
        async () => {
          const view = await api(cp!.baseUrl, "GET", `/api/v1/orbs/${orb}`);
          writeFileSync(join(root, "login-view.json"), JSON.stringify(view, null, 2));
          return loginCode(view.body);
        },
        { timeoutMs: 60_000 },
      );
      await fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: code });
      await waitFor(
        "execution host and central harness ready",
        async () => {
          if (cp!.process.exitCode !== null || cp!.process.signalCode !== null) {
            throw new FatalProbeError(`control plane exited: ${cp!.logs.join("")}`);
          }
          const view = await api(cp!.baseUrl, "GET", `/api/v1/orbs/${orb}`);
          if (view.body["state"] === "failed") throw new FatalProbeError(JSON.stringify(view.body));
          return view.body["state"] === "running" ? true : null;
        },
        { timeoutMs: 300_000 },
      );
      expect(
        (
          await api(cp.baseUrl, "PUT", `/api/v1/orbs/${orb}/messages/${randomUUID()}`, {
            content: [{ type: "text", text: "DURABLE_REMOTE" }],
          })
        ).status,
      ).toBe(202);
      await waitFor("central committed history", async () => {
        const history = await api(cp!.baseUrl, "GET", `/api/v1/orbs/${orb}/history`);
        return JSON.stringify(history.body).includes("DURABLE_REMOTE_DONE") ? true : null;
      });
      await waitFor("remote turn summary settled", async () =>
        cp!.logs.join("").includes("harness.summary_completed") ? true : null,
      );
      const workspace = join(root, "hosts", orb, "workspace");
      expect(readFileSync(join(workspace, "repo", "durable-file.txt"), "utf8")).toBe(
        "REMOTE_WRITE_OK",
      );
      expect(Number(readFileSync(join(workspace, "repo", "durable-shell-pid"), "utf8"))).not.toBe(
        cp.process.pid,
      );
      expect(existsSync(join(workspace, "pi-sessions"))).toBe(false);
      expect(cp.logs.join("")).toMatch(
        new RegExp(`orb=${orb} harness\\.opened[^\\n]*processId=${cp.process.pid}(?:\\s|$)`),
      );
      const metadata = JSON.parse(readFileSync(join(root, "hosts", orb, "host.json"), "utf8")) as {
        processGroupId: number;
      };
      const children = readFileSync(
        `/proc/${metadata.processGroupId}/task/${metadata.processGroupId}/children`,
        "utf8",
      )
        .trim()
        .split(/\s+/);
      expect(children).toHaveLength(1);
      const command = readFileSync(`/proc/${children[0]}/cmdline`, "utf8");
      expect(command).toContain("/runtime-entry.ts");
      expect(command).not.toContain("/pi/");
      expect(readFileSync(`/proc/${children[0]}/environ`, "utf8").split("\0")).toContain(
        "PI_ORB_RUNTIME_MODE=execution",
      );
      browser = await chromium.launch({
        ...(existsSync("/usr/bin/chromium") ? { executablePath: "/usr/bin/chromium" } : {}),
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage();
      await page.goto(`${cp.baseUrl}/orbs/${orb}`);
      await expectPage(page.getByText("DURABLE_REMOTE_DONE", { exact: true })).toBeVisible();
      const thinking = page.getByRole("button", { name: "Change thinking", exact: true });
      await expectPage(thinking).toBeEnabled();
      await expectPage(thinking).toHaveText("high");
      await expectPage(
        page.getByRole("button", { name: "Change model", exact: true }),
      ).toContainText("Sol");
      await thinking.click();
      await page.getByRole("option", { name: "low", exact: true }).click();
      await expectPage(thinking).toHaveText("low");
      expect(
        (
          await api(cp.baseUrl, "PUT", `/api/v1/orbs/${orb}/messages/${randomUUID()}`, {
            content: [{ type: "text", text: "DURABLE_ACCEPTANCE" }],
          })
        ).status,
      ).toBe(202);
      await waitFor("child remote execution gate", async () =>
        existsSync(join(workspace, "repo", "durable-child-ready")) ? true : null,
      );
      const gated = await waitFor(
        "gated central activity published independently of VM",
        async () => {
          const view = await api(cp!.baseUrl, "GET", `/api/v1/orbs/${orb}`);
          return view.body["state"] === "running" && view.body["activity"] === "busy" ? view : null;
        },
      );
      writeFileSync(join(root, "gated-view.json"), JSON.stringify(gated, null, 2));
      expect(gated.body).toMatchObject({ state: "running", activity: "busy" });
      await expectPage(page.locator(".orb-life")).toContainText("busy");
      await expectPage(
        page.getByRole("status", { name: "Agent working", exact: true }),
      ).toBeVisible();
      await writeFile(join(workspace, "repo", "durable-parent-release"), "release\n");
      await waitFor("steering admitted at gated child checkpoint", async () =>
        existsSync(join(workspace, "repo", "durable-steer-ready")) ? true : null,
      );
      await writeFile(join(workspace, "repo", "durable-child-release"), "release\n");
      await waitFor("complete MCP/code-mode/child/native execution", async () => {
        const history = await api(cp!.baseUrl, "GET", `/api/v1/orbs/${orb}/history`);
        writeFileSync(join(root, "acceptance-history.json"), JSON.stringify(history.body, null, 2));
        return JSON.stringify(history.body).includes("DURABLE_ACCEPTANCE_DONE") ? true : null;
      });
      await expectPage(page.getByText("DURABLE_ACCEPTANCE_DONE", { exact: true })).toBeVisible();
      expect(calls.filter((call) => call.method === "tools/call")).toEqual([
        { method: "tools/call", authorization: "Bearer synthetic-durable" },
        { method: "tools/call", authorization: "Bearer synthetic-durable" },
      ]);
      const display = (await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}/history`)).body;
      expect(Check(DisplayHistoryViewSchema, display), JSON.stringify(display)).toBe(true);
      const sessionId = (display["session"] as { id: string }).id;
      const detailRefs = (display["records"] as DisplayRecord[]).flatMap((record) =>
        record.type === "message"
          ? record.content.flatMap((block) =>
              block.type === "tool_result"
                ? [{ recordId: record.id, detailKey: block.detailKey }]
                : [],
            )
          : [],
      );
      expect(detailRefs.length).toBeGreaterThan(0);
      let noticeDetailKey: string | undefined;
      const readDetails = async () => {
        const bodies = [];
        for (const ref of detailRefs) {
          const detail = await api(
            cp!.baseUrl,
            "GET",
            `/api/v1/orbs/${orb}/details/${encodeURIComponent(ref.recordId)}/${encodeURIComponent(ref.detailKey)}?sessionId=${encodeURIComponent(sessionId)}`,
          );
          expect(detail.status).toBe(200);
          expect(detail.body).toMatchObject({
            state: "committed",
            sessionId,
            recordId: ref.recordId,
            detailKey: ref.detailKey,
          });
          if (ref.detailKey === noticeDetailKey)
            expect(detail.body["body"]).toEqual({ type: "subagent", message });
          bodies.push(detail.body);
        }
        return JSON.stringify(bodies);
      };
      let details = await readDetails();
      expect(details).toContain("MCP_CALL_OK:root");
      expect(
        (
          await api(
            cp.baseUrl,
            "GET",
            `/api/v1/orbs/${orb}/details/missing/missing%3A0?sessionId=${encodeURIComponent(sessionId)}`,
          )
        ).status,
      ).toBe(404);
      let canonical = await readReplicatedHistorySnapshot(cp, orb);
      const acceptance = JSON.stringify(canonical);
      expect(acceptance).toContain("DURABLE_NATIVE_ALERT");
      const rootAlert = canonical.records.find(
        (record) => record.type === "event" && record.eventType === "orb.alert",
      );
      expect(rootAlert).toMatchObject({ alert: { message: "DURABLE_NATIVE_ALERT" } });
      expect(acceptance).toContain("MCP_CALL_OK:root");
      expect(acceptance).toContain("aborted");
      expect(acceptance).not.toContain("synthetic-durable");
      expect(acceptance).not.toContain("CHILD_PRIVATE_MCP");
      await page.reload();
      await expectPage(page.getByText("DURABLE_ACCEPTANCE_DONE", { exact: true })).toBeVisible();
      await expectPage(thinking).toHaveText("low");
      await waitFor("acceptance turn summary settled", async () =>
        cp!.logs.join("").split("harness.summary_completed").length === 3 ? true : null,
      );
      await waitFor("completed central work becomes idle", async () =>
        (await api(cp!.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["activity"] === "idle"
          ? true
          : null,
      );
      const modelRequests = await fakeControl(fake.sessionKey, "/requests");
      if (!Array.isArray(modelRequests)) throw new FatalProbeError("missing model requests");
      expect(
        modelRequests.filter(
          (request: { surface: string; body?: { model?: string } }) =>
            request.surface === "model" && request.body?.model === "gpt-6-luna",
        ),
      ).toHaveLength(2);
      expect(
        modelRequests.filter(
          (request: { surface: string; status: number }) =>
            request.surface === "model" && request.status !== 200,
        ),
      ).toEqual([]);
      // Finish the reload's acknowledgement before suspending the selected orb view.
      await waitFor("orb view acknowledgement settled", async () =>
        (await api(cp!.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["unreadAlertId"] === undefined
          ? true
          : null,
      );
      await page.goto("about:blank");
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
      await waitFor("readonly notification live sync", async () =>
        frames.some((frame) => frame.type === "sync.completed") ? true : null,
      );
      const notificationFrameStart = frames.length;
      // Notification phase shares the existing execution host and lifecycle.
      const active = cp;
      const view = async () => (await api(active.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body;
      const history = async () => readReplicatedHistorySnapshot(active, orb);
      const unreadBefore = (await view())["unreadAlertId"];
      expect(
        (
          await api(cp.baseUrl, "PUT", `/api/v1/orbs/${orb}/messages/${randomUUID()}`, {
            content: [{ type: "text", text: "NOTIFY_START" }],
          })
        ).status,
      ).toBe(202);
      const checkout = join(root, "hosts", orb, "workspace", "repo");
      await waitFor("child alert gate owned by execution host", async () =>
        existsSync(join(checkout, "notify-child-ready")) ? true : null,
      );
      // The fake consumes one global ordered rule stream. Gate parent inference
      // until the child's first response has reached the execution host.
      await writeFile(join(checkout, "notify-spawn-release"), "release\n");
      // Capture only this phase's root calls, not earlier acceptance traffic.
      await waitFor("parent wait codemode running", async () => {
        const calls = new Set(
          frames
            .slice(notificationFrameStart)
            .flatMap((frame) =>
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
        return committedToolOutput(
          snapshot.records.slice(canonical.records.length),
          "NOTIFY_WAIT_CONTINUED",
        )
          ? snapshot
          : null;
      });
      writeFileSync(join(root, "private-history.json"), JSON.stringify(privateHistory, null, 2));
      const transcript = JSON.stringify(privateHistory);
      const notificationRecords = privateHistory.records.slice(canonical.records.length);
      const waitOutput = notificationRecords.filter((record) =>
        committedToolOutput([record], "NOTIFY_WAIT_CONTINUED"),
      );
      expect(committedToolOutput(waitOutput, "NOTIFY_WAIT_CONTINUED")).toBe(true);
      expect(committedToolOutput(waitOutput, '"status":"running"')).toBe(true);
      expect(committedToolOutput(waitOutput, '"interrupted":"parent_input"')).toBe(true);
      expect(transcript).toContain("DETAIL_ONLY_TAIL");
      expect(
        privateHistory.records.filter(
          (record) => record.type === "event" && record.eventType === "orb.alert",
        ),
      ).toEqual(
        canonical.records.filter(
          (record) => record.type === "event" && record.eventType === "orb.alert",
        ),
      );
      expect(
        privateHistory.records.filter(
          (record) => record.type === "message" && record.role === "user",
        ),
      ).toHaveLength(
        canonical.records.filter((record) => record.type === "message" && record.role === "user")
          .length + 1,
      );
      expect((await view())["unreadAlertId"]).toBe(unreadBefore);
      const notification = cp.modelRequests?.find((request) =>
        latestUserMessage(request)?.includes("PRIVATE_CHILD_COORDINATION"),
      );
      expect(notification).toBeDefined();
      const spawnReceipt = notificationRecords
        .flatMap((record) =>
          record.type === "message"
            ? record.content.flatMap((block) =>
                block.type === "tool_result"
                  ? block.content.filter(
                      (item) => item.type === "text" && item.text.includes('"agent_id"'),
                    )
                  : [],
              )
            : [],
        )
        .find((block) => block.type === "text" && !block.text.includes('"status"'));
      expect(spawnReceipt?.type).toBe("text");
      const agentId = spawnReceipt?.type === "text" ? JSON.parse(spawnReceipt.text).agent_id : null;
      expect(agentId).toEqual(expect.any(String));
      expect(JSON.parse(latestUserMessage(notification) ?? "null")).toMatchObject({
        agent_id: agentId,
        description: "notification sender",
        message,
      });
      const notice = privateHistory.records.find(
        (record) => record.type === "event" && record.subagent?.message === message,
      );
      expect(notice).toMatchObject({
        eventType: "pi.custom_message",
        subagent: { kind: "notification", id: agentId, message },
      });
      const compact = (await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}/history`)).body;
      expect(compact["records"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: notice?.id,
            subagent: {
              kind: "notification",
              id: agentId,
              description: "notification sender",
              messagePreview,
              detailKey: `${notice?.id}:subagent`,
            },
          }),
        ]),
      );
      expect(JSON.stringify(compact)).not.toContain("DETAIL_ONLY_TAIL");
      noticeDetailKey = `${notice?.id}:subagent`;
      detailRefs.push({ recordId: notice?.id ?? "", detailKey: noticeDetailKey });
      details = await readDetails();
      expect(details).toContain("DETAIL_ONLY_TAIL");
      const liveNotice = await waitFor(
        "correlated compact notification delivered",
        async () =>
          frames.find(
            (frame) => frame.type === "history.record" && frame.record.id === notice?.id,
          ) ?? null,
      );
      expect(liveNotice).toMatchObject({ record: { subagent: { id: agentId, messagePreview } } });
      expect(JSON.stringify(frames)).not.toContain("DETAIL_ONLY_TAIL");

      // Release only after proving the parent handled the alert with a live child.
      await writeFile(join(checkout, "notify-child-release"), "release\n");
      await writeFile(join(checkout, "notify-parent-release"), "release\n");
      await waitFor("parent notification response committed", async () =>
        JSON.stringify(await history()).includes("NOTIFY_PARENT_DONE") ? true : null,
      );
      await waitFor("notification turn summary settled", async () =>
        active.logs.join("").split("harness.summary_completed").length === 4 ? true : null,
      );
      expect(JSON.stringify(await history())).toContain("NOTIFY_CHILD_RECEIPT");
      await waitFor("notification work idle", async () =>
        (await view())["activity"] === "idle" ? true : null,
      );
      expect(
        (
          await api(cp.baseUrl, "PUT", `/api/v1/orbs/${orb}/messages/${randomUUID()}`, {
            content: [{ type: "text", text: "NOTIFY_ESCALATE" }],
          })
        ).status,
      ).toBe(202);
      const escalated = await waitFor("root alert public and unread", async () => {
        const snapshot = await history();
        const alert = snapshot.records.find(
          (record) =>
            record.type === "event" &&
            record.eventType === "orb.alert" &&
            record.alert?.message === "ROOT_PUBLIC_ESCALATION",
        );
        return alert &&
          (await view())["unreadAlertId"] === alert.id &&
          JSON.stringify(snapshot).includes("NOTIFY_ESCALATION_DONE")
          ? snapshot
          : null;
      });
      expect(
        escalated.records.filter(
          (record) =>
            record.type === "event" &&
            record.eventType === "orb.alert" &&
            record.alert?.message === "ROOT_PUBLIC_ESCALATION",
        ),
      ).toMatchObject([{ alert: { message: "ROOT_PUBLIC_ESCALATION" } }]);
      await waitFor("escalation turn summary settled", async () =>
        active.logs.join("").split("harness.summary_completed").length === 5 ? true : null,
      );
      canonical = await history();
      expect((await api(cp.baseUrl, "POST", `/api/v1/orbs/${orb}/stop`)).status).toBe(202);
      await waitFor("stopped", async () =>
        (await api(cp!.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["state"] === "stopped"
          ? true
          : null,
      );
      expect(
        JSON.stringify((await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}/history`)).body),
      ).toContain("DURABLE_REMOTE_DONE");
      expect(await readDetails()).toBe(details);
      expect((await api(cp.baseUrl, "POST", `/api/v1/orbs/${orb}/start`)).status).toBe(202);
      await waitFor(
        "reopened",
        async () =>
          (await api(cp!.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["state"] === "running"
            ? true
            : null,
        { timeoutMs: 300_000 },
      );
      expect(
        JSON.stringify((await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}/history`)).body),
      ).toContain("DURABLE_REMOTE_DONE");
      await page.goto(`${cp.baseUrl}/orbs/${orb}`);
      await expectPage(page.getByText("DURABLE_ACCEPTANCE_DONE", { exact: true })).toBeVisible();
      await expectPage(thinking).toHaveText("low");
      expect(await readDetails()).toBe(details);
      const reopened = await readReplicatedHistorySnapshot(cp, orb);
      expect(reopened.records.slice(0, canonical.records.length)).toEqual(canonical.records);
      expect(reopened.session).toEqual(canonical.session);
      const offeredCatalogs = cp.modelRequests?.filter(
        (request) => requestedTools(request).length > 0,
      );
      expect(offeredCatalogs?.length).toBeGreaterThan(2);
      expect(offeredCatalogs?.every(onlyCodemodeCatalog)).toBe(true);
      const childRequest = cp.modelRequests?.find(
        (request) => latestUserMessage(request) === "DURABLE_CHILD",
      );
      expect(childRequest).toBeDefined();
      expect(onlyCodemodeCatalog(childRequest)).toBe(true);
      expect(JSON.stringify(reopened)).toContain("ORB_NAMESPACE_OK");
      expect((await api(cp.baseUrl, "POST", `/api/v1/orbs/${orb}/archive`)).status).toBe(202);
      await waitFor(
        "archive purges private state",
        async () => ((await view())["state"] === "archived" ? true : null),
        { timeoutMs: 125_000 },
      );
      expect(existsSync(workspace)).toBe(false);
      expect((await history()).records).toEqual(expect.arrayContaining([notice]));
      expect(await readDetails()).toBe(details);
      await cp.stop();
      const persistence = new PGlite(join(root, "db"));
      try {
        const native = await persistence.query<{ count: number }>(
          "SELECT COUNT(*)::integer AS count FROM durable_pg_entries WHERE orb_id = $1",
          [orb],
        );
        expect(native.rows[0]?.count).toBe(0);
        const retained = await persistence.query<{ record: unknown }>(
          "SELECT record FROM history_records WHERE orb_id=$1 AND record_id=$2",
          [orb, notice?.id],
        );
        expect(retained.rows[0]?.record).toEqual(notice);
      } finally {
        await persistence.close();
      }
      failed = false;
    } catch (error) {
      writeFileSync(join(root, "failure.txt"), String(error));
      throw error;
    } finally {
      socket?.terminate();
      writeFileSync(join(root, "frames.json"), JSON.stringify(frames, null, 2));
      if (cp) writeFileSync(join(root, "control-plane.log"), cp.logs.join(""));
      writeFileSync(join(root, "teardown.json"), JSON.stringify({ failed, phase: "started" }));
      await browser?.close();
      if (cp) {
        await cp.stop();
        writeFileSync(join(root, "control-plane.log"), cp.logs.join(""));
      }
      remote.closeAllConnections();
      await new Promise<void>((resolve) => remote.close(() => resolve()));
      await deleteFakeSession(nameFake.sessionKey);
      const requests = await fakeControl(fake.sessionKey, "/requests");
      writeFileSync(join(root, "model-requests.json"), JSON.stringify(requests, null, 2));
      if (cp?.modelRequests)
        writeFileSync(
          join(root, "original-model-requests.json"),
          JSON.stringify(cp.modelRequests, null, 2),
        );
      await deleteFakeSession(fake.sessionKey);
      if (failed) {
        const evidence = join(import.meta.dirname, "../test-failures", `durable-process-${runId}`);
        mkdirSync(evidence, { recursive: true });
        cpSync(root, evidence, { recursive: true });
        console.error(`Durable process E2E evidence: ${evidence}`);
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  720_000,
);

it.runIf(process.env["PI_ORB_E2E_BACKEND"] === "process")(
  "peer input interrupts an actual parent subagent wait without cancelling the child",
  async () => {
    const runId = randomUUID();
    const root = mkdtempSync(join(tmpdir(), "pi-orb-peer-wait-"));
    const project = randomUUID();
    const parent = randomUUID();
    const sender = randomUUID();
    const parentInput = randomUUID();
    const senderInput = randomUUID();
    const peerText = "PEER_WAIT_COORDINATION";
    const checkout = (orb: string) => join(root, "hosts", orb, "workspace", "repo");
    const stop = { type: "stop", status: "completed" };
    let failed = true;
    let cp: Awaited<ReturnType<typeof startControlPlane>> | undefined;
    const fake = await createFakeSession(`peer-wait-${runId}`, {
      auth: { accountId: "peer-wait", device: { manualApprove: true } },
      model: {
        rules: [
          {
            match: { userMessage: { regex: "^PEER_WAIT_START$" } },
            steps: [
              codemode(`
text(await tools.bash({command:'mkfifo peer-spawn-release peer-child-release peer-parent-release'}));
const child = JSON.parse(await tools.subagent({prompt:'PEER_WAIT_CHILD',description:'peer wait child'}));
store('peer-child', child.agent_id);
text(await tools.bash({command:'read value < peer-spawn-release'}));
text('PEER_CHILD_SPAWNED');`),
              stop,
            ],
          },
          {
            match: { userMessage: { regex: "^PEER_WAIT_CHILD$" } },
            steps: [
              codemode(`
text(await tools.bash({command:'printf ready > peer-child-ready; read value < peer-child-release; printf finished > peer-child-finished'}));
text('PEER_CHILD_RELEASED');`),
              stop,
            ],
          },
          {
            match: { toolResultContains: { regex: "PEER_CHILD_SPAWNED" } },
            steps: [
              codemode(`
text(await tools.write({path:'peer-wait-entered',content:'ready'}));
text(await tools.get_subagent_result({agent_id:load('peer-child'),wait:true}));
text('PEER_WAIT_INTERRUPTED');`),
              stop,
            ],
          },
          {
            match: { userMessage: { regex: "^PEER_WAIT_SEND$" } },
            steps: [
              codemode(`
text(await tools.bash({command:'mkfifo peer-sender-release'}));
text(await tools.orb_send({orbId:${JSON.stringify(parent)},message:${JSON.stringify(peerText)}}));
text(await tools.bash({command:'printf accepted > peer-send-accepted; read value < peer-sender-release'}));`),
              stop,
            ],
          },
          {
            match: { userMessage: { regex: peerText } },
            steps: [
              codemode(`
text(await tools.get_subagent_result({agent_id:load('peer-child'),wait:false}));
text('PEER_CHILD_STILL_RUNNING');
text(await tools.bash({command:'printf handled > peer-parent-handled; read value < peer-parent-release'}));
text(await tools.get_subagent_result({agent_id:load('peer-child'),wait:true}));
text('PEER_CHILD_JOINED');`),
              stop,
            ],
          },
          // Child, parent, sender and summary inference may interleave after release.
          ...Array.from({ length: 6 }, () => ({
            match: { default: true },
            steps: [{ type: "text", content: "PEER_WAIT_FINISHED" }, stop],
          })),
        ],
      },
    });
    const nameFake = await createFakeSession(`peer-wait-names-${runId}`, {
      model: {
        rules: [{ match: { default: true }, steps: [{ type: "text", content: "Peer" }, stop] }],
      },
    });
    try {
      cp = await startControlPlane({
        port: 7274,
        fake,
        nameFake,
        pglitePath: join(root, "db"),
        authDir: join(root, "auth"),
        hostingRoot: join(root, "hosting"),
        processStateDirectory: join(root, "hosts"),
        durableStateDirectory: join(root, "authority"),
        extraEnv: { PI_ORB_E2E_HISTORY_INSPECTION: "1" },
      });
      const active = cp;
      const history = () => readReplicatedHistorySnapshot(active, parent);
      const inbox = async () =>
        (
          await api(active.baseUrl, "POST", `/api/v1/orbs/${parent}/messages/poll`, {
            after: 0,
            tracked: [],
          })
        ).body["items"] as {
          id: string;
          status: string;
          delivery?: string;
          operationId?: string;
        }[];
      const send = (orb: string, id: string, text: string) =>
        api(active.baseUrl, "PUT", `/api/v1/orbs/${orb}/messages/${id}`, {
          content: [{ type: "text", text }],
        });
      expect(
        (
          await api(active.baseUrl, "POST", "/api/v1/projects", {
            id: project,
            name: "Peer wait",
            repositoryUrl: "https://github.com/schani/pi-orb",
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await api(active.baseUrl, "POST", `/api/v1/projects/${project}/orbs`, {
            id: parent,
          })
        ).status,
      ).toBe(202);
      const code = await waitFor("peer wait model login", async () =>
        loginCode((await api(active.baseUrl, "GET", `/api/v1/orbs/${parent}`)).body),
      );
      await fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: code });
      expect(
        (
          await api(active.baseUrl, "POST", `/api/v1/projects/${project}/orbs`, {
            id: sender,
          })
        ).status,
      ).toBe(202);
      for (const orb of [parent, sender]) {
        await waitFor(
          `peer wait execution host ${orb}`,
          async () => {
            const view = await api(active.baseUrl, "GET", `/api/v1/orbs/${orb}`);
            if (view.body["state"] === "failed")
              throw new FatalProbeError(JSON.stringify(view.body));
            return view.body["state"] === "running" ? true : null;
          },
          { timeoutMs: 300_000 },
        );
      }
      expect((await send(parent, parentInput, "PEER_WAIT_START")).status).toBe(202);
      await waitFor("peer wait child holds release FIFO", async () =>
        existsSync(join(checkout(parent), "peer-child-ready")) ? true : null,
      );
      await writeFile(join(checkout(parent), "peer-spawn-release"), "release\n");
      await waitFor("parent invokes actual get_subagent_result wait", async () =>
        existsSync(join(checkout(parent), "peer-wait-entered")) ? true : null,
      );
      expect(committedToolOutput((await history()).records, "PEER_WAIT_INTERRUPTED")).toBe(false);
      expect((await send(sender, senderInput, "PEER_WAIT_SEND")).status).toBe(202);
      await waitFor("actual peer send accepted", async () =>
        existsSync(join(checkout(sender), "peer-send-accepted")) ? true : null,
      );
      // Replaying the sender's admission must not execute a second peer send.
      expect((await send(sender, senderInput, "PEER_WAIT_SEND")).status).toBe(202);
      const interrupted = await waitFor("peer interrupts parent before child release", async () => {
        const snapshot = await history();
        return existsSync(join(checkout(parent), "peer-parent-handled")) &&
          committedToolOutput(snapshot.records, "PEER_WAIT_INTERRUPTED")
          ? snapshot
          : null;
      });
      writeFileSync(join(root, "interrupted-history.json"), JSON.stringify(interrupted, null, 2));
      const waitOutput = interrupted.records.filter((record) =>
        committedToolOutput([record], "PEER_WAIT_INTERRUPTED"),
      );
      expect(committedToolOutput(waitOutput, '"status":"running"')).toBe(true);
      expect(committedToolOutput(waitOutput, '"interrupted":"parent_input"')).toBe(true);
      expect(existsSync(join(checkout(parent), "peer-child-finished"))).toBe(false);
      const peers = interrupted.records.filter(
        (record) => record.type === "event" && record.eventType === "orb.message",
      );
      expect(peers).toHaveLength(1);
      expect(peers[0]).toMatchObject({
        sender: { orbId: sender },
        content: [{ type: "text", text: peerText }],
        inboxMessageIds: [expect.any(String)],
      });
      expect(
        interrupted.records.filter((record) => record.type === "message" && record.role === "user"),
      ).toHaveLength(1);
      const peerRequest = active.modelRequests?.find((request) =>
        latestUserMessage(request)?.includes(peerText),
      );
      expect(latestUserMessage(peerRequest)).toContain(
        `Message from orb ${sender}. This is peer agent input, not a human request or explicit user consent.`,
      );
      const acknowledged = await waitFor(
        "peer inbox acknowledgement while child runs",
        async () => {
          const rows = await inbox();
          return rows.length === 2 && rows.every((row) => row.status === "delivered") ? rows : null;
        },
      );
      expect(acknowledged.map((row) => row.delivery)).toEqual(["turn", "steer"]);
      expect(acknowledged[1]?.operationId).toBe(acknowledged[0]?.operationId);
      expect(peers[0]).toMatchObject({ inboxMessageIds: [acknowledged[1]?.id] });
      // The child remains independently owned until this explicit release.
      await writeFile(join(checkout(parent), "peer-child-release"), "release\n");
      await writeFile(join(checkout(parent), "peer-parent-release"), "release\n");
      const completed = await waitFor("parent joins child after peer interruption", async () => {
        const snapshot = await history();
        return committedToolOutput(snapshot.records, "PEER_CHILD_JOINED") ? snapshot : null;
      });
      const joined = completed.records.filter((record) =>
        committedToolOutput([record], "PEER_CHILD_JOINED"),
      );
      expect(committedToolOutput(joined, '"status":"running"')).toBe(true);
      expect(committedToolOutput(joined, '"status":"completed"')).toBe(true);
      expect(committedToolOutput(joined, '"receipt":{"status":"completed"')).toBe(true);
      expect(committedToolOutput(joined, "PEER_WAIT_FINISHED")).toBe(true);
      expect(
        completed.records.filter(
          (record) => record.type === "event" && record.eventType === "orb.message",
        ),
      ).toEqual(peers);
      await writeFile(join(checkout(sender), "peer-sender-release"), "release\n");
      for (const orb of [parent, sender]) {
        await waitFor(`peer wait work idle ${orb}`, async () =>
          (await api(active.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["activity"] === "idle"
            ? true
            : null,
        );
      }
      failed = false;
    } catch (error) {
      writeFileSync(join(root, "failure.txt"), String(error));
      throw error;
    } finally {
      if (cp) {
        await cp.stop();
        writeFileSync(join(root, "control-plane.log"), cp.logs.join(""));
        writeFileSync(join(root, "model-requests.json"), JSON.stringify(cp.modelRequests, null, 2));
      }
      await deleteFakeSession(nameFake.sessionKey);
      await deleteFakeSession(fake.sessionKey);
      if (failed) {
        const evidence = join(import.meta.dirname, "../test-failures", `peer-wait-${runId}`);
        mkdirSync(evidence, { recursive: true });
        cpSync(root, evidence, { recursive: true });
        console.error(`Peer wait E2E evidence: ${evidence}`);
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  720_000,
);
