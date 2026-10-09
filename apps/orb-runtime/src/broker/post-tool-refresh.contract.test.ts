import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { NoSimulationTask } from "determined";
import { ok } from "neverthrow";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { BrokerTokenClient } from "../domain/broker-client.ts";
import { type InferenceStageAudit, installInferenceStages } from "../pi/inference-stages.ts";
import { HttpBrokerEndpoint } from "./endpoint.ts";
import { brokerProviderConfig } from "./provider.ts";

it.each(["headers", "body"])(
  "a held %s refresh after persisted tools honors abort and releases auth ownership",
  async (phase) => {
    const dir = mkdtempSync(join(tmpdir(), "post-tool-refresh-"));
    const authPath = join(dir, "auth.json");
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
    const token = `${encode({})}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })}.sig`;
    let inferenceRequests = 0;
    let brokerRequests = 0;
    let recover = false;
    let entered = () => {};
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const server = createServer((request, response) => {
      if (request.url?.includes("/runtime/v1/tokens/model")) {
        brokerRequests++;
        if (brokerRequests === 1 || recover) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              accessToken: token,
              accountId: "fixture",
              expiresAt: Date.now() + 3600000,
              generation: brokerRequests,
            }),
          );
        } else {
          if (phase === "body") {
            response.writeHead(200, { "content-type": "application/json" });
            response.write("{");
          }
          entered();
        }
        return;
      }
      inferenceRequests++;
      const call = {
        type: "function_call",
        id: "fc",
        call_id: "call",
        name: "fixture",
        arguments: "{}",
      };
      const events = [
        { type: "response.created", response: { id: "resp" } },
        { type: "response.output_item.added", output_index: 0, item: call },
        { type: "response.output_item.done", output_index: 0, item: call },
        {
          type: "response.completed",
          response: { id: "resp", status: "completed", output: [call] },
        },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing listener");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const task = new NoSimulationTask("post-tool-refresh", false);
    const http = new HttpBrokerEndpoint(
      { controlPlaneUrl: baseUrl, runtimeToken: "fixture" },
      "model",
    );
    let drained = () => {};
    const ioDrained = new Promise<void>((resolve) => {
      drained = resolve;
    });
    const client = new BrokerTokenClient({
      requestToken: async (...args) => {
        try {
          return await http.requestToken(...args);
        } finally {
          if (brokerRequests === 2) drained();
        }
      },
    });
    const runtime = await ModelRuntime.create({ authPath, allowModelNetwork: false });
    const provider = brokerProviderConfig(task, client, { inferenceBaseUrl: baseUrl });
    runtime.registerProvider("openai-codex", provider);
    await runtime.login("openai-codex", "oauth", {
      prompt: async () => {
        throw new Error("unexpected prompt");
      },
      notify: () => {},
    });
    const manager = SessionManager.create(dir, join(dir, "sessions"));
    const model = runtime.getModels("openai-codex")[0];
    if (!model) throw new Error("missing pinned model");
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let completion: Promise<void> | undefined;
    try {
      ({ session } = await createAgentSession({
        cwd: dir,
        agentDir: join(dir, "agent"),
        modelRuntime: runtime,
        sessionManager: manager,
        model,
        tools: ["fixture"],
        settingsManager: SettingsManager.inMemory({
          transport: "sse",
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
        customTools: [
          {
            name: "fixture",
            label: "Fixture",
            description: "Fixture",
            parameters: Type.Object({}),
            execute: async () => {
              const stored = JSON.parse(readFileSync(authPath, "utf8"));
              stored["openai-codex"].expires = Date.now() + 240000;
              stored["openai-codex"].stageFixture = true;
              writeFileSync(authPath, JSON.stringify(stored, null, 2));
              return { content: [{ type: "text", text: "fixture-result" }], details: undefined };
            },
          },
        ],
      }));
      const stages: InferenceStageAudit[] = [];
      installInferenceStages(
        session.agent,
        {
          now: Date.now,
          identity: () => ({ operationId: "fixture", sessionId: manager.getSessionId() }),
          audit: (row) => {
            stages.push(row);
            manager.appendCustomEntry("pi-orb.inference-stage", row);
            return ok(undefined);
          },
          failed: () => expect.fail("stage persistence failed"),
        },
        runtime,
      );
      completion = session.prompt("Call fixture then continue.");
      await held;
      const file = manager.getSessionFile();
      if (!file) throw new Error("missing session file");
      const persisted = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(persisted.some((row) => row.message?.role === "toolResult")).toBe(true);
      expect(inferenceRequests).toBe(1);
      expect(
        stages.filter((row) => row.stage === "provider_http" && row.edge === "enter"),
      ).toHaveLength(1);
      expect(session.isIdle).toBe(false);
      expect(stages.findLast((row) => row.stage === "auth_resolution")).toMatchObject({
        edge: "enter",
      });
      expect(existsSync(`${authPath}.lock`)).toBe(true);
      const aborted = session.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const fence = new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("still-blocked"), 1000);
        });
        expect(await Promise.race([aborted.then(() => "settled"), fence])).toBe("settled");
        expect(await Promise.race([ioDrained.then(() => "drained"), fence])).toBe("drained");
      } finally {
        clearTimeout(timer);
      }
      await completion;
      expect(session.isIdle).toBe(true);
      recover = true;
      const recovered = await runtime.getAuth("openai-codex");
      expect(recovered?.auth.apiKey).toBe(token);
      expect(existsSync(`${authPath}.lock`)).toBe(false);
      expect(brokerRequests).toBe(3);
      expect(client.currentGrant()?.generation).toBe(3);
    } finally {
      recover = true;
      const stopping = session?.abort();
      server.closeAllConnections();
      await stopping;
      await completion;
      session?.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
  10000,
);
