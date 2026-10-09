import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { NoSimulationTask } from "determined";
import { err, okAsync } from "neverthrow";
import { Agent, fetch as localFetch } from "undici";
import { expect, it, vi } from "vitest";
import { composeControlPlaneDatabase } from "./adapters/database.ts";
import { DurableAgent } from "./adapters/durable/agent.ts";
import * as waitProgress from "./adapters/durable/execution-wait-progress.ts";
import * as durableModels from "./adapters/durable/models.ts";
import { LazyExecutionEnv } from "./adapters/execution-client/lazy-env.ts";
import { PGliteClient } from "./adapters/pg/pglite-client.ts";
import { MCP_OAUTH_SECRETS, McpOAuth, type StoredMcpOAuth } from "./domain/mcp-oauth.ts";
import { createProcessAgentContext } from "./process-agent-composition.ts";
import { FakeSecretStore } from "./testkit/broker.ts";
import { makeHarness, makeOrbRow, makeProjectRow, seedTestUser } from "./testkit/fixtures.ts";

it.each(["typed-boundary", "typed-unavailable", "pglite"] as const)(
  "publishes OAuth grant edges through production composition (%s)",
  async (boundary) => {
    let acceptedCalls = 0;
    let requests = 0;
    const root = mkdtempSync(join(tmpdir(), "mcp-composed-"));
    const key = join(root, "key.pem");
    const cert = join(root, "cert.pem");
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
        "/CN=fixture",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-days",
        "1",
      ],
      { stdio: "ignore" },
    );
    const dispatcher = new Agent({ connect: { ca: readFileSync(cert) } });
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(((input, init) =>
        localFetch(input as string, { ...init, dispatcher } as never)) as typeof fetch);
    const server = createServer(
      { key: readFileSync(key), cert: readFileSync(cert) },
      async (request, response) => {
        requests++;
        if (request.method !== "POST") {
          response.writeHead(405).end();
          return;
        }
        let raw = "";
        for await (const chunk of request) raw += chunk;
        if (request.headers.authorization !== "Bearer TEST-ACCESS") {
          response.writeHead(401).end();
          return;
        }
        const message = JSON.parse(raw);
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        if (message.method === "tools/call") acceptedCalls++;
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              }
            : message.method === "tools/list"
              ? { tools: [{ name: "read", inputSchema: { type: "object" } }] }
              : { content: [{ type: "text", text: "OAUTH_READ_OK" }] };
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    expect(address).not.toBeTypeOf("string");
    const url = `https://127.0.0.1:${(address as { port: number }).port}/mcp`;
    const h = makeHarness();
    const projectId = "00000000-0000-4000-8000-000000000071";
    const orb = makeOrbRow("00000000-0000-4000-8000-000000000073", projectId, "starting");
    h.store.seedProject(makeProjectRow(projectId));
    h.store.seedOrb(orb);
    const binding = { projectId, id: "00000000-0000-4000-8000-000000000072", url };
    const catalog = {
      revision: 0,
      servers: [
        { name: "fixture", description: "fixture", url, headers: {}, oauth: { id: binding.id } },
      ],
    };
    const task = new NoSimulationTask("mcp composed missing grant", false);
    const logs: string[] = [];
    vi.spyOn(task, "log").mockImplementation((line) => {
      logs.push(String(line));
    });
    const db = boundary === "pglite" ? composeControlPlaneDatabase(new PGliteClient()) : undefined;
    const secrets = new FakeSecretStore();
    let authorized = false;
    const oauth = db ? new McpOAuth(db.mcpOAuth, secrets, {} as never) : undefined;
    const token = vi.fn(async (...args: Parameters<McpOAuth["token"]>) =>
      oauth
        ? oauth.token(...args)
        : authorized
          ? okAsync({
              accessToken: "TEST-ACCESS",
              accountId: "test",
              generation: 1,
              expiresAt: task.wallNow() + 3_600_000,
            })
          : err({
              type: "mcp_oauth_error" as const,
              code:
                boundary === "typed-unavailable"
                  ? ("unavailable" as const)
                  : ("auth_required" as const),
              message: "PRIVATE-OAUTH-FAILURE",
            }),
    );
    const faux = fauxProvider();
    const turn = () => [
      fauxAssistantMessage(
        fauxToolCall("codemode", { code: "text(await tools.mcp__fixture__read({}))" }),
        { stopReason: "toolUse" as const },
      ),
      fauxAssistantMessage("done"),
    ];
    faux.setResponses([...turn(), ...turn(), ...turn()]);
    const models = createModels();
    models.setProvider(faux.provider);
    const modelBoundary = vi
      .spyOn(durableModels, "createDurableModels")
      .mockReturnValue(okAsync(models as never));
    const storage = new MemoryStorage();
    const publishProgress = vi.fn();
    const realWaitProgress = waitProgress.executionWaitProgress;
    const progressBoundary = vi
      .spyOn(waitProgress, "executionWaitProgress")
      .mockImplementation((api, ctx, phase) => {
        const progressApi = realWaitProgress(api, ctx, phase);
        return {
          ...progressApi,
          details: async (value, context) => {
            publishProgress(value);
            await progressApi.details(value, context);
          },
        };
      });
    let agent: DurableAgent | undefined;
    try {
      if (db) {
        (await db.migrate())._unsafeUnwrap();
        (await seedTestUser(task, db.users))._unsafeUnwrap();
        (await db.store.insertProject(task, makeProjectRow(projectId)))._unsafeUnwrap();
        (await db.mcp.replace(task, projectId, catalog))._unsafeUnwrap();
      }
      const open = createProcessAgentContext(h.deps, {
        resources: {
          acquire: () =>
            okAsync({
              orbId: orb.id,
              commitSha: "a".repeat(40),
              instructionPath: null,
              skillRoot: null,
              files: [],
            }),
        },
        mcp: db?.mcp ?? { read: () => okAsync(catalog) },
        mcpOAuth: { token },
      } as never);
      const options = (
        await open(task, orb, { signal: new AbortController().signal }, false, {
          storage,
          signal: new AbortController().signal,
          check: () => okAsync(undefined),
          beginDrain: () => okAsync(undefined),
          release: () => okAsync(undefined),
          artifacts: { read: () => okAsync(null), write: () => okAsync("/orb-artifacts/fixture") },
        })
      )._unsafeUnwrap();
      agent = (
        await DurableAgent.open({
          ...options,
          orbId: orb.id,
          storage,
          initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
        })
      )._unsafeUnwrap();
      const owner = agent;
      const deliver = async (id: string) => {
        (
          await owner.deliver({
            baseUrl: "central",
            messageId: id,
            messageIds: [id],
            content: [{ type: "text", text: id }],
          })
        )._unsafeUnwrap();
        (await owner.waitForIdle())._unsafeUnwrap();
        return owner.snapshot()._unsafeUnwrap();
      };
      const first = await deliver("original input");
      expect(progressBoundary).toHaveBeenCalledOnce();
      const invocationEnv = progressBoundary.mock.calls[0]?.[0].env;
      expect(invocationEnv).toBeInstanceOf(LazyExecutionEnv);
      expect(invocationEnv).not.toBe(options.env);
      expect(publishProgress).not.toHaveBeenCalled();
      const native = await storage.scanEntries(
        { conversationId: ROOT_CONVERSATION_ID },
        100,
        undefined,
        BACKGROUND_CONTEXT,
      );
      const toolResults = native.items.filter((entry) => entry.kind === "pi.tool-result");
      const unavailableStatus = boundary === "typed-unavailable" ? "unavailable" : "needs-auth";
      expect(toolResults).toHaveLength(1);
      expect(JSON.stringify(toolResults[0]?.model)).toContain(`MCP fixture: ${unavailableStatus}.`);
      expect(toolResults[0]?.data).toEqual({
        diagnostics: [
          { severity: "info", code: "mcp_status", message: `MCP fixture: ${unavailableStatus}.` },
        ],
      });
      expect(JSON.stringify(toolResults)).not.toContain("PRIVATE-OAUTH-FAILURE");
      expect(token).toHaveBeenCalledTimes(2);
      expect(requests).toBe(0);
      expect(acceptedCalls).toBe(0);
      const publicTools = first.records
        .filter((record) => record.type === "message")
        .filter((record) => record.role === "tool");
      expect(
        JSON.stringify(publicTools.map((record) => record.content)).split(
          `MCP fixture: ${unavailableStatus}.`,
        ),
      ).toHaveLength(2);
      expect(JSON.stringify(first.records)).not.toContain("PRIVATE-OAUTH-FAILURE");
      expect(logs.filter((line) => line.includes("durable.mcp_unavailable"))).toEqual([
        expect.stringContaining(
          `server=fixture status=${unavailableStatus} stage=discovery errorCategory=unavailable`,
        ),
      ]);
      expect(
        first.records
          .filter((record) => record.type === "message")
          .filter((record) => record.role === "user")
          .map((record) => record.content),
      ).toEqual([[{ type: "text", text: "original input" }]]);
      expect(
        first.records
          .filter((record) => record.type === "message")
          .filter((record) => record.role === "assistant")
          .map((record) => record.finishReason),
      ).toEqual(["toolUse", "stop"]);
      expect(JSON.stringify(first.records)).not.toContain("TEST-ACCESS");
      const identity = agent.health();
      expect(identity.status).toBe("ready");
      if (identity.status !== "ready") return;
      if (db) {
        const credential: StoredMcpOAuth = {
          projectId,
          connectionId: binding.id,
          oauth: {},
          access: "TEST-ACCESS",
          refresh: "TEST-REFRESH",
          accountId: binding.id,
          expiresAt: task.wallNow() + 3_600_000,
        };
        const saved = (
          await secrets.writeSecret(task, MCP_OAUTH_SECRETS, credential)
        )._unsafeUnwrap();
        (
          await db.mcpOAuth.cas(
            task,
            binding,
            null,
            {
              generation: 1,
              secretVersion: saved.version,
              refreshLeaseUntil: 0,
              lastRefreshAt: 0,
              attempt: null,
            },
            "connected",
          )
        )._unsafeUnwrap();
      }
      authorized = true;
      const second = await deliver("authorized input");
      expect(publishProgress).toHaveBeenCalled();
      expect(JSON.stringify(second.records)).toContain("OAUTH_READ_OK");
      expect(acceptedCalls).toBe(1);
      expect(agent.health()).toMatchObject({
        sessionId: identity.sessionId,
        runtimeInstanceId: identity.runtimeInstanceId,
      });
      const third = await deliver("healthy input");
      expect(acceptedCalls).toBe(2);
      const publicToolHistory = third.records
        .filter((record) => record.type === "message")
        .filter((record) => record.role === "tool");
      expect(
        JSON.stringify(publicToolHistory.map((record) => record.content)).match(
          /MCP fixture: connected\./g,
        ),
      ).toHaveLength(1);
      expect(
        JSON.stringify(publicToolHistory.map((record) => record.content)).split(
          `MCP fixture: ${unavailableStatus}.`,
        ),
      ).toHaveLength(2);
      expect(logs.filter((line) => line.includes("durable.mcp_unavailable"))).toHaveLength(1);
      expect(JSON.stringify(third.records)).not.toContain("TEST-ACCESS");
      expect(JSON.stringify(third.records)).not.toContain("TEST-REFRESH");
    } finally {
      await agent?.close();
      modelBoundary.mockRestore();
      progressBoundary.mockRestore();
      await db?.close();
      network.mockRestore();
      await dispatcher.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
