import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as httpServer, type ServerResponse } from "node:http";
import { createServer as httpsServer } from "node:https";
import { join } from "node:path";
import { type Browser, chromium, expect as expectPage, type Page } from "@playwright/test";
import { build } from "vite";
import { expect, it as test } from "vitest";
import {
  api,
  createFakeSession,
  deleteFakeSession,
  effectiveOpenAIResponseInstructions,
  FatalProbeError,
  fakeControl,
  forceReconcilePass,
  newModelRequestsById,
  readReplicatedHistorySnapshot,
  startControlPlane,
  waitFor,
} from "./harness.ts";
import { holdModelStream } from "./held-model-stream.ts";
import { runTerminal } from "./terminal-client.ts";
import { runArtifactRestart } from "./testkit/durable-artifact-restart.ts";
import { onlyCodemodeCatalog, requestedTools } from "./testkit/durable-model-fixture.ts";
import { readonlySubscription } from "./testkit/durable-subscription.ts";
import {
  committedToolOutput,
  lifecycleEdge,
  operationEvent,
  summaryOutcome,
} from "./testkit/durable-wait-barriers.ts";

const evidenceRoot =
  process.env["PI_ORB_E2E_EVIDENCE_DIR"] ??
  join(import.meta.dirname, "../test-failures/durable-independent-process");
const stop = { type: "stop", status: "completed" };
const summary = {
  match: { userMessage: { regex: "^Write a single short desktop-notification sentence" } },
  steps: [{ type: "text", content: "Central work completed." }, stop],
};

const privatePolicy =
  "PRIVATE_POLICY_SENTINEL: Never write MUST_NOT_EXIST. After readiness, append allowed to ALLOWED_AFTER_READY instead.";
const hookPolicy =
  "HOOK_POLICY_SENTINEL: Never write MUST_NOT_EXIST or ALLOWED_AFTER_READY. Append changed to HOOK_ALLOWED_AFTER_READY instead.";

const it = test.runIf(process.env["PI_ORB_E2E_BACKEND"] === "process");

export type IndependentCase =
  | "abort"
  | "stop"
  | "host-failure"
  | "ready"
  | "git-stop"
  | "hook-policy"
  | "git-abort"
  | "artifact-restart";

export function registerIndependentCase(cancellation: IndependentCase) {
  it(`central inference, MCP and native tools precede execution readiness: ${cancellation}`, async () => {
    expect(process.env["PI_ORB_E2E_BACKEND"], "requires real process backend").toBe("process");
    const evidence = join(evidenceRoot, `${cancellation}-${randomUUID()}`);
    const root = join(evidence, "fixture");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(evidence, "fixture-root.txt"), root);
    const orb = randomUUID(),
      project = randomUUID(),
      firstMessage = randomUUID();
    const workspace = join(root, "hosts", orb, "workspace", "repo");
    mkdirSync(join(workspace, ".agents"), { recursive: true });
    let held: ServerResponse | undefined;
    let released = false;
    const gateEvents: string[] = [];
    const gate = httpServer((_req, res) => {
      gateEvents.push("setup-readiness-entered");
      held = res;
      if (released) res.end("released");
    });
    await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
    const gateAddress = gate.address();
    if (!gateAddress || typeof gateAddress === "string")
      throw new Error("missing barrier listener");
    writeFileSync(
      join(workspace, ".agents", "setup"),
      `#!/bin/sh\nnode -e 'fetch("http://127.0.0.1:${gateAddress.port}/hold").then(r=>r.text()).then(()=>{})'\n${cancellation === "hook-policy" ? `printf '%s' '${hookPolicy}' > AGENTS.md\n` : ""}`,
      { mode: 0o755 },
    );
    writeFileSync(join(workspace, "AGENTS.md"), privatePolicy);
    mkdirSync(join(workspace, ".agents/skills/pinned"), { recursive: true });
    writeFileSync(
      join(workspace, ".agents/skills/pinned/SKILL.md"),
      "---\nname: pinned\ndescription: Pinned resource fixture\n---\nRead asset.txt.\n",
    );
    writeFileSync(join(workspace, ".agents/skills/pinned/asset.txt"), "PINNED_RESOURCE_ASSET");
    execFileSync("git", ["init", "-q", "-b", "main", workspace]);
    execFileSync("git", ["-C", workspace, "add", "."]);
    execFileSync("git", [
      "-C",
      workspace,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "blocking setup readiness barrier",
    ]);
    const pinnedSha = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    let resourceHeld: ServerResponse | undefined;
    let resourceReleased = false;
    let resourcesOffline = false;
    let resourceAcquisitions = 0;
    const resourceOutcomes: string[] = [];
    const resourceGate = httpServer((req, res) => {
      const request = new URL(req.url ?? "/", "http://fixture");
      if (request.searchParams.get("phase") === "settled") {
        resourceOutcomes.push(request.searchParams.get("outcome") ?? "missing");
        res.end("settled");
        return;
      }
      resourceAcquisitions++;
      resourceHeld = res;
      if (resourceReleased && !resourcesOffline) res.end("resources released");
    });
    await new Promise<void>((resolve) => resourceGate.listen(0, "127.0.0.1", resolve));
    const resourceAddress = resourceGate.address();
    if (!resourceAddress || typeof resourceAddress === "string")
      throw new Error("missing resource gate");
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
        "/CN=independent-fixture",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-days",
        "1",
      ],
      { stdio: "ignore" },
    );
    const mcpCalls: string[] = [];
    const mcp = httpsServer(
      { key: readFileSync(key), cert: readFileSync(cert) },
      async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const message = JSON.parse(body);
        mcpCalls.push(message.method);
        if (message.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "web", version: "1" },
              }
            : message.method === "tools/list"
              ? { tools: [{ name: "search", inputSchema: { type: "object", properties: {} } }] }
              : { content: [{ type: "text", text: "CP_WEB_SEARCH_OK" }] };
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      },
    );
    await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
    const mcpAddress = mcp.address();
    if (!mcpAddress || typeof mcpAddress === "string") throw new Error("missing MCP listener");
    const webRoot = join(import.meta.dirname, "../apps/web");
    await build({
      root: webRoot,
      configFile: join(webRoot, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir: join(root, "web"), emptyOutDir: true },
    });
    const fake = await createFakeSession(`independent-${randomUUID()}`, {
      auth: { accountId: "independent", device: { manualApprove: true } },
      model: {
        rules: [
          {
            match: { userMessage: { regex: "^CENTRAL_FIRST$" } },
            steps: [
              { type: "text", content: "EARLY_CENTRAL_ASSISTANT" },
              {
                type: "toolCall",
                name: "codemode",
                arguments: {
                  code: "text(await tools.read({path:'.agents/skills/pinned/SKILL.md'})); text(await tools.read({path:'.agents/skills/pinned/asset.txt'})); text(await tools.mcp__web__search({})); text(await tools.orb_self({})); text(await tools.orb_alert({message:'CP_NATIVE_BEFORE_VM'})); text('CP_TOOLS_DONE');",
                },
              },
              stop,
            ],
          },
          {
            match: { toolResultContains: { regex: "CP_TOOLS_DONE" } },
            steps: [{ type: "text", content: "CENTRAL_FIRST_DONE" }, stop],
          },
          summary,
          {
            match: { userMessage: { regex: "^VM_EFFECT$" } },
            steps: [
              {
                type: "toolCall",
                name: "bash",
                arguments: {
                  command: "printf 'allowed\\n' >> ALLOWED_AFTER_READY; printf VM_EXECUTED_ONCE",
                },
              },
              stop,
            ],
          },
          ...(cancellation === "stop"
            ? [
                {
                  match: {
                    toolResultContains: {
                      regex: "Tool codemode was interrupted and may have partially run",
                    },
                  },
                  steps: [
                    { type: "reasoning", text: "STOP_RECOVERY_DONE" },
                    { type: "text", content: "RESUMED_STREAM_BEFORE_COMPLETION" },
                    {
                      type: "toolCall",
                      name: "codemode",
                      arguments: {
                        code: "text(await tools.read({path:'.agents/skills/pinned/SKILL.md'})); text('SNAPSHOT_REOPEN:' + await tools.read({path:'.agents/skills/pinned/asset.txt'})); text('SNAPSHOT_AFTER_STOP');",
                      },
                    },
                    stop,
                  ],
                },
                summary,
              ]
            : []),
          ...(cancellation === "host-failure"
            ? [
                {
                  match: {
                    toolResultContains: {
                      regex: "Execution failed; use Start or new input to retry[.]",
                    },
                  },
                  steps: [{ type: "text", content: "VM_FAILURE_VISIBLE" }, stop],
                },
                summary,
              ]
            : []),
          ...(cancellation === "ready" || cancellation === "hook-policy"
            ? [
                ...[
                  {
                    match: {
                      toolResultContains: { regex: "Host instructions adopted; re-evaluate" },
                    },
                    steps: [
                      {
                        type: "text",
                        content:
                          cancellation === "hook-policy"
                            ? "HOOK_POLICY_REEVALUATED"
                            : "READY_POLICY_REEVALUATED",
                      },
                      {
                        type: "toolCall",
                        name: "bash",
                        arguments: {
                          command:
                            cancellation === "hook-policy"
                              ? "printf 'changed\\n' >> HOOK_ALLOWED_AFTER_READY; printf VM_EXECUTED_ONCE"
                              : "printf 'allowed\\n' >> ALLOWED_AFTER_READY; printf VM_EXECUTED_ONCE",
                        },
                      },
                      stop,
                    ],
                  },
                ],
                {
                  match: { toolResultContains: { regex: "VM_EXECUTED_ONCE" } },
                  steps: [{ type: "text", content: "READY_VM_DONE" }, stop],
                },
                summary,
              ]
            : []),
          {
            match: { userMessage: { regex: "^FUTURE_CENTRAL$" } },
            steps: [{ type: "text", content: "FUTURE_CENTRAL_DONE" }, stop],
          },
          summary,
          {
            match: { userMessage: { regex: "^RESUME_STREAM$" } },
            steps: [
              { type: "text", content: "RESUMED_STREAM_BEFORE_COMPLETION" },
              {
                type: "toolCall",
                name: "codemode",
                arguments: {
                  code: "text(await tools.read({path:'.agents/skills/pinned/SKILL.md'})); text('SNAPSHOT_REOPEN:' + await tools.read({path:'.agents/skills/pinned/asset.txt'})); text('SNAPSHOT_AFTER_STOP');",
                },
              },
              stop,
            ],
          },
          {
            match: { toolResultContains: { regex: "SNAPSHOT_AFTER_STOP" } },
            steps: [{ type: "text", content: "RESUMED_SNAPSHOT_READ_DONE" }, stop],
          },
          summary,
        ],
      },
    });
    const names = await createFakeSession(`independent-names-${randomUUID()}`, {
      model: {
        rules: [
          { match: { default: true }, steps: [{ type: "text", content: "Independent" }, stop] },
        ],
      },
    });
    const modelStream =
      cancellation === "stop"
        ? await holdModelStream(fake.inferenceBaseUrl, "RESUME_STREAM")
        : undefined;
    let cp: Awaited<ReturnType<typeof startControlPlane>> | undefined;
    let browser: Browser | undefined, page: Page | undefined;
    const frames: { direction: "sent" | "received"; payload: string; socketGeneration: number }[] =
      [];
    let socketGeneration = 0;
    const priorRequests: Record<string, unknown>[] = [];
    const priorLogs: string[] = [];
    let navigations = 0;
    let failed = true;
    const loginAbort = new AbortController();
    let loginApproval: Promise<{ ok: true } | { ok: false; cause: unknown }> | undefined;
    const release = () => {
      released = true;
      gateEvents.push("setup-readiness-released");
      held?.end("released");
    };
    try {
      // Reserve an ephemeral listener before selecting the CP port; no fixed-port fixture collision.
      const lease = httpServer();
      await new Promise<void>((resolve) => lease.listen(0, "127.0.0.1", resolve));
      const address = lease.address();
      if (!address || typeof address === "string") throw new Error("missing CP port lease");
      await new Promise<void>((resolve) => lease.close(() => resolve()));
      const cpOptions = {
        port: address.port,
        fake,
        nameFake: names,
        pglitePath: join(root, "db"),
        authDir: join(root, "auth"),
        hostingRoot: join(root, "hosting"),
        processStateDirectory: join(root, "hosts"),
        durableStateDirectory: join(root, "authority"),
        resourceRepository: workspace,
        resourceGateUrl: `http://127.0.0.1:${resourceAddress.port}/resources${cancellation === "git-abort" ? "?reportOutcome=1" : ""}`,
        webDist: join(root, "web"),
        launchFailureMarker: "armed.json",
        extraEnv: {
          NODE_EXTRA_CA_CERTS: cert,
          PI_ORB_E2E_RECONCILE_CHECKPOINTS: "1",
          PI_ORB_E2E_HISTORY_INSPECTION: "1",
          ...(modelStream ? { PI_ORB_FAKE_OPENAI_INFERENCE_URL: modelStream.baseUrl } : {}),
        },
      };
      cp = await startControlPlane(cpOptions);
      expect(
        (
          await api(cp.baseUrl, "POST", "/api/v1/projects", {
            id: project,
            name: "Independent",
            repositoryUrl: "https://github.com/schani/pi-orb",
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await api(cp.baseUrl, "PUT", `/api/v1/projects/${project}/mcp`, {
            revision: 0,
            servers: [
              {
                name: "web",
                description: "Fake web search",
                headers: {},
                url: `https://127.0.0.1:${mcpAddress.port}/mcp`,
              },
            ],
          })
        ).status,
      ).toBe(200);
      expect(
        (await api(cp.baseUrl, "POST", `/api/v1/projects/${project}/orbs`, { id: orb })).status,
      ).toBe(202);
      expect(
        (
          await api(cp.baseUrl, "PUT", `/api/v1/orbs/${orb}/messages/${firstMessage}`, {
            content: [{ type: "text", text: "CENTRAL_FIRST" }],
          })
        ).status,
      ).toBe(202);
      loginApproval = waitFor(
        "central Codex login",
        async () => {
          if (loginAbort.signal.aborted) throw new FatalProbeError("login fixture cancelled");
          const view = await api(cp!.baseUrl, "GET", `/api/v1/orbs/${orb}`);
          const action = view.body["actionRequired"] as
            | { type?: string; userCode?: string }
            | undefined;
          return action?.type === "openai_codex_device_login" && action.userCode
            ? action.userCode
            : null;
        },
        { timeoutMs: 60_000 },
      )
        .then((code) => fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: code }))
        .then(
          () => ({ ok: true as const }),
          (cause: unknown) => ({ ok: false as const, cause }),
        );
      await waitFor("required Git snapshot acquisition held before first inference", async () =>
        resourceHeld ? true : null,
      );
      expect(cp.modelRequests).toHaveLength(0);
      expect(resourceReleased).toBe(false);
      if (cancellation === "git-abort") {
        browser = await chromium.launch({
          ...(existsSync("/usr/bin/chromium") ? { executablePath: "/usr/bin/chromium" } : {}),
          args: ["--no-sandbox"],
        });
        page = await browser.newPage();
        page.on("websocket", (socket) => {
          const generation = ++socketGeneration;
          socket.on("framereceived", (frame) =>
            frames.push({
              direction: "received",
              payload: String(frame.payload),
              socketGeneration: generation,
            }),
          );
          socket.on("framesent", (frame) =>
            frames.push({
              direction: "sent",
              payload: String(frame.payload),
              socketGeneration: generation,
            }),
          );
        });
        await page.goto(`${cp.baseUrl}/orbs/${orb}`);
        await expectPage(page.getByRole("button", { name: "abort", exact: true })).toBeVisible();
        const frameStart = frames.length;
        await page.getByRole("button", { name: "abort", exact: true }).click();
        const abortRequest = await waitFor(
          "browser Abort request while Git gate remains held",
          async () => {
            const frame = frames
              .slice(frameStart)
              .find((item) => item.direction === "sent" && item.payload.includes('"type":"abort"'));
            return frame ? (JSON.parse(frame.payload) as { requestId: string }) : null;
          },
        );
        await waitFor("Abort ACK before resource acquisition completes", async () => {
          const result = frames
            .slice(frameStart)
            .filter((item) => item.direction === "received")
            .map((item) => JSON.parse(item.payload))
            .find(
              (item) => item.type === "request.result" && item.requestId === abortRequest.requestId,
            );
          if (!result) return null;
          expect(result.result).toMatchObject({
            type: "accepted",
            operationId: `inbox:${firstMessage}`,
          });
          return true;
        });
        expect(resourceReleased).toBe(false);
        expect(cp.modelRequests).toHaveLength(0);
        await expectPage(
          page.getByRole("button", { name: "abort", exact: true }),
        ).not.toBeVisible();
        resourceReleased = true;
        resourceHeld?.end("late resource release after Abort ACK");
        await waitFor("cancelled Git acquisition settles", async () =>
          resourceOutcomes.length > 0 ? true : null,
        );
        // Browser demand may warm compute independently of the cancelled turn.
        release();
        for (let pass = 0; pass < 3; pass++) await forceReconcilePass(cp, orb);
        await waitFor("aborted first turn removed from durable inbox and agent idle", async () => {
          const [view, messages] = await Promise.all([
            api(cp!.baseUrl, "GET", `/api/v1/orbs/${orb}`),
            api(cp!.baseUrl, "POST", `/api/v1/orbs/${orb}/messages/poll`, {
              after: 0,
              tracked: [],
            }),
          ]);
          const items = messages.body["items"] as { id: string; status: string; error?: unknown }[];
          return view.body["activity"] === "idle" &&
            items.length > 0 &&
            items.every((item) => item.status !== "queued" && item.status !== "delivering")
            ? true
            : null;
        });
        await forceReconcilePass(cp, orb);
        expect(cp.modelRequests).toHaveLength(0);
        const cancelled = (
          await api(cp.baseUrl, "POST", `/api/v1/orbs/${orb}/messages/poll`, {
            after: 0,
            tracked: [],
          })
        ).body["items"] as { id: string; status: string; error?: unknown }[];
        expect(cancelled.find((item) => item.id === firstMessage)).toMatchObject({
          status: "failed",
        });
        const history = await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}/history`);
        expect(JSON.stringify(history.body)).not.toContain("Cancelledbeforeagentadmission");
        expect(JSON.stringify(history.body)).not.toContain("CENTRAL_FIRST_DONE");
        failed = false;
        return;
      }
      if (cancellation === "git-stop") {
        expect((await api(cp.baseUrl, "POST", `/api/v1/orbs/${orb}/stop`)).status).toBe(202);
        await waitFor(
          "Stop cancels pending Git snapshot without opening inference",
          async () =>
            (await api(cp!.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["state"] === "stopped"
              ? true
              : null,
          { timeoutMs: 10_000 },
        );
        resourceReleased = true;
        resourceHeld?.end("late resource release");
        browser = await chromium.launch({
          ...(existsSync("/usr/bin/chromium") ? { executablePath: "/usr/bin/chromium" } : {}),
          args: ["--no-sandbox"],
        });
        page = await browser.newPage();
        await page.goto(`${cp.baseUrl}/orbs/${orb}`);
        await expectPage(page.getByRole("textbox").first()).toBeEnabled();
        for (let pass = 0; pass < 3; pass++) await forceReconcilePass(cp, orb);
        expect((await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["state"]).toBe("stopped");
        expect(cp.modelRequests).toHaveLength(0);
        expect(resourceAcquisitions).toBe(1);
        expect(existsSync(join(workspace, "ALLOWED_AFTER_READY"))).toBe(false);
        failed = false;
        return;
      }
      resourceReleased = true;
      resourceHeld?.end("resources released");
      const approval = await loginApproval;
      if (!approval.ok) throw approval.cause;
      await waitFor(
        "blocking setup hook entered readiness barrier before any model turn",
        async () => (held ? true : null),
        { timeoutMs: 60_000 },
      );
      browser = await chromium.launch({
        ...(existsSync("/usr/bin/chromium") ? { executablePath: "/usr/bin/chromium" } : {}),
        args: ["--no-sandbox"],
      });
      page = await browser.newPage();
      page.on("framenavigated", (frame) => {
        if (frame === page!.mainFrame()) navigations++;
      });
      page.on("websocket", (socket) => {
        const generation = ++socketGeneration;
        socket.on("framereceived", (frame) =>
          frames.push({
            direction: "received",
            payload: String(frame.payload),
            socketGeneration: generation,
          }),
        );
        socket.on("framesent", (frame) =>
          frames.push({
            direction: "sent",
            payload: String(frame.payload),
            socketGeneration: generation,
          }),
        );
      });
      await page.goto(`${cp.baseUrl}/orbs/${orb}`);
      await expectPage(page.getByRole("textbox").first()).toBeEnabled();
      const submit = async (text: string) => {
        expect(
          (
            await api(cp!.baseUrl, "PUT", `/api/v1/orbs/${orb}/messages/${randomUUID()}`, {
              content: [{ type: "text", text }],
            })
          ).status,
        ).toBe(202);
      };
      await expectPage(page.getByText("EARLY_CENTRAL_ASSISTANT", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expectPage(page.getByText("CENTRAL_FIRST_DONE", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      expect(released).toBe(false);
      expect(mcpCalls.filter((method) => method === "tools/call")).toHaveLength(1);
      const beforeVM = { body: await readReplicatedHistorySnapshot(cp, orb) };
      writeFileSync(
        join(evidence, "before-ready-history.json"),
        JSON.stringify(beforeVM.body, null, 2),
      );
      expect(JSON.stringify(beforeVM.body)).toContain("CP_WEB_SEARCH_OK");
      expect(JSON.stringify(beforeVM.body)).toContain("PINNED_RESOURCE_ASSET");
      expect(JSON.stringify(beforeVM.body)).not.toContain("PRIVATE_POLICY_SENTINEL");
      expect(JSON.stringify(beforeVM.body)).not.toContain("agent identity rejected");
      expect(beforeVM.body["records"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            alert: expect.objectContaining({ message: "CP_NATIVE_BEFORE_VM" }),
          }),
        ]),
      );
      const heldView = await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}`);
      const heldMetadata = JSON.parse(readFileSync(join(root, "hosts", orb, "host.json"), "utf8"));
      const heldHealth = await (
        await fetch(`http://127.0.0.1:${heldMetadata.port}/v1/health`)
      ).json();
      writeFileSync(
        join(evidence, "held-setup-readiness.json"),
        JSON.stringify({ state: heldView.body["state"], health: heldHealth }, null, 2),
      );
      expect(heldView.body["state"]).toMatch(/^(creating|starting)$/);
      expect(heldHealth).toMatchObject({ status: "initializing" });
      expect(held?.writableEnded).toBe(false);
      expect(held?.destroyed).toBe(false);
      await page.screenshot({ path: join(evidence, "early-output.png"), fullPage: true });
      const barrierEvents: Record<string, unknown>[] = [];
      const summarySettled = async (operationId: string, after = 0) => {
        await waitFor(`summary settled for ${operationId}`, async () => {
          const outcome = summaryOutcome([cp!.logs.join("").slice(after)], orb, operationId);
          if (outcome === "failed")
            throw new FatalProbeError(`summary failed for orb=${orb} operation=${operationId}`);
          return outcome === "completed" ? true : null;
        });
        barrierEvents.push({ phase: "summary-completed", orb, operationId });
        writeFileSync(
          join(evidence, "waiting-phases.json"),
          JSON.stringify(barrierEvents, null, 2),
        );
      };
      const firstSummary = await waitFor(
        "orb first summary queued",
        async () => lifecycleEdge(cp!.logs, orb, "harness.summary_queued") ?? null,
      );
      expect(firstSummary["operationId"]).toBeTruthy();
      await summarySettled(firstSummary["operationId"]!);
      if (cancellation === "artifact-restart") {
        await runArtifactRestart({
          cp,
          cpOptions,
          browser,
          page,
          orb,
          evidence,
          privatePolicy,
          fake,
          submit,
          priorRequests,
          priorLogs,
          restart: (next) => {
            cp = next;
          },
          setPage: (next) => {
            page = next;
          },
          disableResources: () => {
            resourcesOffline = true;
            released = false;
            held = undefined;
          },
          resourceAcquisitions: () => resourceAcquisitions,
          released: () => released,
          release,
        });
        failed = false;
        return;
      }
      const requestStart = cp.modelRequests?.length ?? 0;
      const frameStart = frames.length;
      const logStart = cp.logs.join("").length;
      await submit("VM_EFFECT");
      await waitFor("model admission for VM_EFFECT", async () =>
        cp!.modelRequests
          ?.slice(requestStart)
          .some((request) => JSON.stringify(request).includes('"VM_EFFECT"'))
          ? true
          : null,
      );
      const publishedTool = await waitFor(
        "model tool publication for VM_EFFECT",
        async () =>
          operationEvent(frames.slice(frameStart), undefined, "tool_state", {
            name: "codemode",
            state: "running",
          }) ?? null,
      );
      const operationId = String(publishedTool["operationId"]);
      const callId = String(publishedTool["callId"]);
      await waitFor("backend execution wait publication", async () =>
        lifecycleEdge(cp!.logs, orb, "execution.tool_waiting", { call_id: callId }) &&
        operationEvent(frames.slice(frameStart), operationId, "tool_state", {
          callId,
          message: "Waiting for execution.",
        })
          ? true
          : null,
      );
      barrierEvents.push({ phase: "execution-wait-acknowledged", orb, operationId, callId });
      writeFileSync(join(evidence, "waiting-phases.json"), JSON.stringify(barrierEvents, null, 2));
      await expectPage(page.getByText(/waiting.*execution|waiting.*VM/i).first()).toBeVisible({
        timeout: 30_000,
      });
      expect(released).toBe(false);
      expect(existsSync(join(workspace, "MUST_NOT_EXIST"))).toBe(false);
      await page.screenshot({ path: join(evidence, "waiting.png"), fullPage: true });
      if (cancellation === "host-failure") {
        const metadata = JSON.parse(readFileSync(join(root, "hosts", orb, "host.json"), "utf8"));
        writeFileSync(
          join(workspace, "..", "armed.json"),
          JSON.stringify({ orbId: orb, incarnation: metadata.incarnation }),
        );
        // The existing launch-failure seam keeps recovery attempts terminal for this incarnation.
        const children = readFileSync(
          `/proc/${metadata.processGroupId}/task/${metadata.processGroupId}/children`,
          "utf8",
        )
          .trim()
          .split(/\s+/)
          .map(Number);
        expect(children).toHaveLength(1);
        expect(readFileSync(`/proc/${children[0]}/cmdline`, "utf8")).toContain("/runtime-entry.ts");
        expect(readFileSync(`/proc/${children[0]}/environ`, "utf8").split("\0")).toContain(
          "PI_ORB_RUNTIME_MODE=execution",
        );
        // Leave the subreaper alive to drain detached hook descendants and publish its receipt.
        process.kill(children[0]!, "SIGKILL");
        await waitFor(
          "terminal execution failure",
          async () =>
            (await api(cp!.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["state"] === "failed"
              ? true
              : null,
          { timeoutMs: 90_000 },
        );
        await expectPage(page.getByText("VM_FAILURE_VISIBLE", { exact: true })).toBeVisible({
          timeout: 30_000,
        });
        expect(released).toBe(false);
        await summarySettled(operationId, logStart);
        await submit("FUTURE_CENTRAL");
        await expectPage(page.getByText("FUTURE_CENTRAL_DONE", { exact: true })).toBeVisible({
          timeout: 30_000,
        });
        expect(existsSync(join(workspace, "MUST_NOT_EXIST"))).toBe(false);
        release();
      } else if (cancellation === "ready" || cancellation === "hook-policy") {
        await expect(
          runTerminal(cp.baseUrl, orb, "pi-orb self --json", "SELF_DONE"),
        ).rejects.toThrow(/ready=false.*code=1013/);
        release();
        await waitFor("execution ready and instructions adopted", async () => {
          const logs = [cp!.logs.join("").slice(logStart)];
          return (await api(cp!.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["state"] ===
            "running" &&
            lifecycleEdge(logs, orb, "execution.tool_ready", { call_id: callId }) &&
            lifecycleEdge(logs, orb, "instructions.host_adopted")
            ? true
            : null;
        });
        await waitFor("ready tool and assistant committed", async () => {
          const history = await readReplicatedHistorySnapshot(cp!, orb);
          const message = (role: string, text: string, exact = false) =>
            history.records.some(
              (record) =>
                record.type === "message" &&
                record.role === role &&
                record.content.some(
                  (block) =>
                    block.type === "text" &&
                    (exact ? block.text === text : block.text.includes(text)),
                ),
            );
          return operationEvent(frames.slice(frameStart), operationId, "tool_state", {
            name: "codemode",
            state: "completed",
          }) &&
            operationEvent(frames.slice(frameStart), operationId, "operation_finished", {
              outcome: "completed",
            }) &&
            committedToolOutput(history.records, "VM_EXECUTED_ONCE") &&
            message("assistant", "READY_VM_DONE", true) &&
            message(
              "assistant",
              cancellation === "hook-policy"
                ? "HOOK_POLICY_REEVALUATED"
                : "READY_POLICY_REEVALUATED",
              true,
            )
            ? true
            : null;
        });
        barrierEvents.push({ phase: "ready-tool-assistant-committed", orb, operationId });
        writeFileSync(
          join(evidence, "waiting-phases.json"),
          JSON.stringify(barrierEvents, null, 2),
        );
        await expectPage(page.getByText("READY_VM_DONE", { exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await summarySettled(operationId, logStart);
        await forceReconcilePass(cp, orb);
        expect((await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["state"]).toBe("running");
        expect(existsSync(join(workspace, "MUST_NOT_EXIST"))).toBe(false);
        if (cancellation === "hook-policy") {
          await expectPage(
            page.getByText("HOOK_POLICY_REEVALUATED", { exact: true }),
          ).toBeVisible();
          expect(existsSync(join(workspace, "ALLOWED_AFTER_READY"))).toBe(false);
          expect(readFileSync(join(workspace, "HOOK_ALLOWED_AFTER_READY"), "utf8")).toBe(
            "changed\n",
          );
        } else {
          await expectPage(
            page.getByText("READY_POLICY_REEVALUATED", { exact: true }),
          ).toBeVisible();
          expect(readFileSync(join(workspace, "ALLOWED_AFTER_READY"), "utf8")).toBe("allowed\n");
        }
        const identity = await runTerminal(
          cp.baseUrl,
          orb,
          "pi-orb self --json; printf 'INDEPENDENT_%s_DONE\\n' SELF",
          "INDEPENDENT_SELF_DONE",
        );
        expect(identity).toContain(orb);
        const history = { body: await readReplicatedHistorySnapshot(cp, orb) };
        writeFileSync(
          join(evidence, "resource-ready-history.json"),
          JSON.stringify(history.body, null, 2),
        );
        expect(JSON.stringify(history.body)).toContain("VM_EXECUTED_ONCE");
        expect(JSON.stringify(history.body)).not.toContain("PRIVATE_POLICY_SENTINEL");
        const recorded = await fakeControl(fake.sessionKey, "/requests");
        expect(Array.isArray(recorded)).toBe(true);
        const models = newModelRequestsById(recorded as unknown as unknown[], new Set());
        const first = models.filter((request) => request["matchedRuleIndex"] === 0);
        const workspaceDecision = models.filter((request) => request["matchedRuleIndex"] === 3);
        expect(first).toHaveLength(1);
        expect(workspaceDecision).toHaveLength(1);
        expect(effectiveOpenAIResponseInstructions(first[0]?.body)).toContain(privatePolicy);
        expect(effectiveOpenAIResponseInstructions(workspaceDecision[0]?.body)).toContain(
          privatePolicy,
        );
        if (cancellation === "hook-policy") {
          const reevaluated = models.filter((request) => request["matchedRuleIndex"] === 4);
          expect(reevaluated).toHaveLength(1);
          expect(effectiveOpenAIResponseInstructions(reevaluated[0]?.body)).toContain(hookPolicy);
          expect(JSON.stringify(history.body)).not.toContain("HOOK_POLICY_SENTINEL");
        }
        expect(
          execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        ).toBe(pinnedSha);
      } else if (cancellation === "abort") {
        await page.getByRole("button", { name: "abort", exact: true }).click();
        await expectPage(page.getByRole("button", { name: "abort", exact: true })).not.toBeVisible({
          timeout: 5_000,
        });
        expect(released).toBe(false);
        await waitFor("cancelled operation retired before setup release", async () =>
          operationEvent(frames.slice(frameStart), operationId, "operation_finished", {
            outcome: "aborted",
          }) &&
          operationEvent(frames.slice(frameStart), undefined, "status", { activity: "idle" }) &&
          lifecycleEdge(cp!.logs, orb, "execution.tool_wait_finished", {
            call_id: callId,
            outcome: "cancelled",
          })
            ? true
            : null,
        );
        barrierEvents.push({ phase: "operation-aborted", orb, operationId, callId });
        release();
        await waitFor(
          "execution ready after cancelled wait",
          async () =>
            (await api(cp!.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["state"] === "running"
              ? true
              : null,
          { timeoutMs: 90_000 },
        );
        await forceReconcilePass(cp, orb);
        expect(existsSync(join(workspace, "MUST_NOT_EXIST"))).toBe(false);
        await submit("FUTURE_CENTRAL");
        await expectPage(page.getByText("FUTURE_CENTRAL_DONE", { exact: true })).toBeVisible({
          timeout: 30_000,
        });
      } else {
        const originalOwner = socketGeneration;
        await page.getByRole("button", { name: "Stop orb", exact: true }).click();
        await waitFor(
          "Stop settles with barrier still closed",
          async () =>
            (await api(cp!.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["state"] === "stopped"
              ? true
              : null,
          { timeoutMs: 10_000 },
        );
        expect(released).toBe(false);
        release();
        const navigationCount = navigations;
        await expectPage(page.getByText("CENTRAL_FIRST_DONE", { exact: true })).toBeVisible();
        const readonlyOwner = await waitFor(
          "stopped original subscription becomes read-only without reload",
          async () => readonlySubscription(frames, originalOwner),
        );
        expect(readonlyOwner).toBe(originalOwner);
        expect(socketGeneration).toBe(originalOwner);
        for (let pass = 0; pass < 3; pass++) await forceReconcilePass(cp, orb);
        expect((await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["state"]).toBe("stopped");
        expect(existsSync(join(workspace, "MUST_NOT_EXIST"))).toBe(false);
        resourcesOffline = true;
        writeFileSync(
          join(workspace, ".agents/skills/pinned/asset.txt"),
          "MOVED_WORKSPACE_RESOURCE_ASSET",
        );
        execFileSync("git", ["-C", workspace, "add", "."]);
        execFileSync("git", [
          "-C",
          workspace,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "-qm",
          "main advanced after persisted snapshot",
        ]);
        expect(
          execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        ).not.toBe(pinnedSha);
        // New compute may warm, but resource reads must not wait for its setup hook.
        released = false;
        held = undefined;
        const resumeFrames = frames.length;
        const composer = page.getByRole("textbox").first();
        await composer.fill("RESUME_STREAM");
        await composer.press("Control+Enter");
        await waitFor("model completion held after resumed deltas", async () => {
          try {
            return modelStream!.held() ? true : null;
          } catch (error) {
            throw new FatalProbeError(`model stream relay failed: ${String(error)}`);
          }
        });
        const patch = await waitFor(
          "original subscription output patch on same page",
          async () =>
            frames
              .slice(resumeFrames)
              .find(
                (frame) =>
                  frame.direction === "received" &&
                  frame.payload.includes('"type":"output_patch"') &&
                  frame.payload.includes("RESUMED_STREAM_BEFORE_COMPLETION"),
              ) ?? null,
        );
        expect(patch.socketGeneration).toBe(originalOwner);
        expect(socketGeneration).toBe(originalOwner);
        await expectPage(
          page.getByText("RESUMED_STREAM_BEFORE_COMPLETION", { exact: true }),
        ).toBeVisible();
        expect(
          frames
            .slice(resumeFrames)
            .some(
              (frame) =>
                frame.direction === "received" &&
                frame.payload.includes('"type":"history.record"') &&
                frame.payload.includes('"role":"assistant"') &&
                frame.payload.includes("RESUMED_STREAM_BEFORE_COMPLETION"),
            ),
        ).toBe(false);
        expect(navigations).toBe(navigationCount);
        modelStream!.release();
        await waitFor("resumed owner final history and completion", async () => {
          const received = frames
            .slice(resumeFrames)
            .filter((frame) => frame.direction === "received");
          return received.some(
            (frame) =>
              frame.payload.includes('"type":"history.record"') &&
              frame.payload.includes('"role":"assistant"') &&
              frame.payload.includes("RESUMED_STREAM_BEFORE_COMPLETION"),
          ) && received.some((frame) => frame.payload.includes('"type":"operation_finished"'))
            ? true
            : null;
        });
        await expectPage(
          page.getByRole("button", { name: "abort", exact: true }),
        ).not.toBeVisible();
        expect(navigations).toBe(navigationCount);
        await expectPage(
          page.getByText("RESUMED_SNAPSHOT_READ_DONE", { exact: true }),
        ).toBeVisible();
        const reopened = { body: await readReplicatedHistorySnapshot(cp, orb) };
        expect(JSON.stringify(reopened.body)).toContain("SNAPSHOT_REOPEN:PINNED_RESOURCE_ASSET");
        expect(resourceAcquisitions).toBe(1);
        expect(released).toBe(false);
        release();
      }
      const requests = await fakeControl(fake.sessionKey, "/requests");
      expect(Array.isArray(requests)).toBe(true);
      expect(
        (requests as unknown as { surface: string; status: number }[]).filter(
          (request) => request.surface === "model" && request.status !== 200,
        ),
      ).toEqual([]);
      const catalogs = cp.modelRequests?.filter((request) => requestedTools(request).length > 0);
      expect(catalogs?.length).toBeGreaterThan(0);
      expect(catalogs?.every(onlyCodemodeCatalog)).toBe(true);
      failed = false;
    } catch (error) {
      writeFileSync(join(evidence, "failure.txt"), String(error));
      throw error;
    } finally {
      loginAbort.abort();
      await loginApproval;
      // Capture authority/history/browser/model evidence before closing their owners.
      if (cp?.modelRequests)
        writeFileSync(
          join(evidence, "original-model-requests.json"),
          JSON.stringify([...priorRequests, ...cp.modelRequests], null, 2),
        );
      if (modelStream)
        writeFileSync(
          join(evidence, "model-stream-fence.json"),
          JSON.stringify(modelStream.observations, null, 2),
        );
      writeFileSync(join(evidence, "browser-frames.json"), JSON.stringify(frames, null, 2));
      if (cp)
        writeFileSync(join(evidence, "control-plane.log"), [...priorLogs, ...cp.logs].join(""));
      const captures = await Promise.allSettled([
        ...(cp
          ? [
              api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}`).then((view) =>
                writeFileSync(join(evidence, "final-view.json"), JSON.stringify(view, null, 2)),
              ),
              api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}/history`).then((history) =>
                writeFileSync(
                  join(evidence, "final-history.json"),
                  JSON.stringify(history, null, 2),
                ),
              ),
            ]
          : []),
        ...(page
          ? [
              page.content().then((html) => writeFileSync(join(evidence, "page.html"), html)),
              page.screenshot({ path: join(evidence, "final-page.png"), fullPage: true }),
            ]
          : []),
        fakeControl(fake.sessionKey, "/requests").then((requests) =>
          writeFileSync(join(evidence, "model-requests.json"), JSON.stringify(requests, null, 2)),
        ),
      ]);
      writeFileSync(
        join(evidence, "capture-outcomes.json"),
        JSON.stringify(
          captures.map((outcome) =>
            outcome.status === "rejected"
              ? { status: outcome.status, reason: String(outcome.reason) }
              : { status: outcome.status },
          ),
          null,
          2,
        ),
      );
      writeFileSync(
        join(evidence, "barrier.json"),
        JSON.stringify(
          {
            failed,
            hook: "setup",
            released,
            gateEvents,
            mcpCalls,
            resourceAcquisitions,
            resourceOutcomes,
          },
          null,
          2,
        ),
      );
      const browserClosed = await Promise.allSettled([browser?.close()]);
      modelStream?.release();
      const processStopped = await Promise.allSettled([cp?.stop(), modelStream?.close()]);
      if (cp)
        writeFileSync(join(evidence, "control-plane.log"), [...priorLogs, ...cp.logs].join(""));
      gate.closeAllConnections();
      mcp.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => gate.close(() => resolve())),
        new Promise<void>((resolve) => {
          resourceHeld?.end("fixture closing");
          resourceGate.closeAllConnections();
          resourceGate.close(() => resolve());
        }),
        new Promise<void>((resolve) => mcp.close(() => resolve())),
      ]);
      const sessionsDeleted = await Promise.allSettled([
        deleteFakeSession(names.sessionKey),
        deleteFakeSession(fake.sessionKey),
      ]);
      const teardown = [...browserClosed, ...processStopped, ...sessionsDeleted];
      writeFileSync(
        join(evidence, "teardown-outcomes.json"),
        JSON.stringify(
          teardown.map((outcome) =>
            outcome.status === "rejected"
              ? { status: outcome.status, reason: String(outcome.reason) }
              : { status: outcome.status },
          ),
          null,
          2,
        ),
      );
      if (!failed) {
        expect(captures.every((outcome) => outcome.status === "fulfilled")).toBe(true);
        expect(teardown.every((outcome) => outcome.status === "fulfilled")).toBe(true);
      }
      // Retain fixture DB, authority and execution logs on success as well as failure.
    }
  }, 300_000);
}
