import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  AgentDoc,
  defineTool,
  type Harness,
  LiveDoc,
  type LiveState,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
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
    let recovered = false;
    let forbiddenEffects = 0;
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
                instructions: recovered ? "RESET_CONSENT_INSTRUCTIONS" : "CONSENT_INSTRUCTIONS",
              }
            : message.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: recovered ? "read_after_reset" : "read",
                      inputSchema: { type: "object" },
                    },
                  ],
                }
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
    const turn = (code = "text(await tools.mcp__fixture__read({}))") => [
      fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" as const }),
      fauxAssistantMessage("done"),
    ];
    faux.setResponses([
      ...turn(),
      ...turn(
        'text(await describeNamespace("mcp__fixture")); text(await describeTool("mcp__fixture__read")); text(await tools.mcp__fixture__read({}))',
      ),
      ...turn(),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const modelBoundary = vi
      .spyOn(durableModels, "createDurableModels")
      .mockReturnValue(okAsync(models as never));
    const storage = new MemoryStorage();
    const publishProgress = vi.fn();
    const publicProgress: Array<{ name: string; state: string }> = [];
    let disposeProgress = () => {};
    const realWaitProgress = waitProgress.executionWaitProgress;
    const forbiddenNames = ["subagent", "orb_spawn", "ambient_forbidden"];
    const nativeDenials: Array<{
      name: string;
      denied: boolean;
      code: string | undefined;
      reason: string | undefined;
    }> = [];
    const progressBoundary = vi
      .spyOn(waitProgress, "executionWaitProgress")
      .mockImplementation((api, ctx, phase): ReturnType<typeof realWaitProgress> => {
        const progress = realWaitProgress(api, ctx, phase);
        if (api.conversationId === ROOT_CONVERSATION_ID) return progress;
        return {
          ...progress,
          executeTool: async (name, args, context, callOptions) => {
            const result = await progress.executeTool(name, args, context, callOptions);
            if (name === "mcp__fixture__read_after_reset") {
              // Exercise native dispatch as well as the sandbox's missing-member guard.
              for (const forbidden of forbiddenNames) {
                const denial = await progress.executeTool(
                  forbidden,
                  forbidden === "ambient_forbidden" ? {} : { prompt: "forbidden child" },
                  context,
                  { key: `child-denial-${forbidden}` },
                );
                const diagnostic = denial.diagnostics.find((item) => item.severity === "error");
                nativeDenials.push({
                  name: forbidden,
                  denied: denial.isError,
                  code: diagnostic?.code,
                  reason: diagnostic?.message,
                });
              }
            }
            return result;
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
          checkInputAdmission: () => okAsync(undefined),
          beginDrain: () => okAsync(undefined),
          release: () => okAsync(undefined),
          artifacts: { read: () => okAsync(null), write: () => okAsync("/orb-artifacts/fixture") },
        })
      )._unsafeUnwrap();
      let resolveConversation: Harness["conversation"] | undefined;
      agent = (
        await DurableAgent.open({
          ...options,
          bindNativeConversation: (resolve, abortTask) => {
            resolveConversation = resolve;
            options.bindNativeConversation?.(resolve, abortTask);
          },
          orbId: orb.id,
          storage,
          initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
        })
      )._unsafeUnwrap();
      const owner = agent;
      const nativeRoot = (await resolveConversation!(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))!;
      const nativeView = await nativeRoot.viewState(BACKGROUND_CONTEXT);
      // Native nested calls publish committed LiveDoc slots, not codemode api.details().
      const unsubscribeNative = nativeView.subscribe((value) => {
        const live = value.docs[LiveDoc.definition.kind] as LiveState | undefined;
        for (const slot of live?.nestedTools ?? []) {
          if (slot.name.startsWith("mcp__fixture__"))
            publishProgress({
              name: slot.name,
              status: slot.status,
              taskId: slot.taskId,
              ...(slot.summary ? { isError: slot.summary.isError } : {}),
            });
        }
      });
      const unsubscribePublic = owner.subscribe(() => {
        for (const tool of owner.liveView()?.tools ?? [])
          publicProgress.push({ name: tool.name, state: tool.state });
      });
      disposeProgress = () => {
        unsubscribeNative();
        unsubscribePublic();
        nativeView.dispose();
      };
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
      publicProgress.length = 0;
      const second = await deliver("authorized input");
      expect(publishProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "mcp__fixture__read",
          status: "running",
        }),
      );
      expect(publishProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "mcp__fixture__read",
          status: "done",
          isError: false,
        }),
      );
      for (const [slot] of publishProgress.mock.calls)
        expect(progressBoundary.mock.calls.some(([api]) => api.taskId === slot.taskId)).toBe(true);
      expect(publicProgress).toContainEqual({ name: "codemode", state: "running" });
      expect(JSON.stringify(second.records)).toContain("OAUTH_READ_OK");
      expect(JSON.stringify(second.records)).toContain("CONSENT_INSTRUCTIONS");
      expect(JSON.stringify(second.records)).toContain("mcp__fixture__read");
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
      if (boundary === "typed-boundary") {
        const rootConversation = (await resolveConversation!(
          ROOT_CONVERSATION_ID,
          BACKGROUND_CONTEXT,
        ))!;
        options.registry.install({
          name: "forbidden-ambient",
          tools: [
            defineTool({
              name: "ambient_forbidden",
              description: "must not reach a child",
              callers: ["tools"],
              parameters: Type.Object({}),
              execute: async () => {
                forbiddenEffects++;
                return {};
              },
            }),
          ],
        });
        faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall("codemode", {
              code: 'const child = JSON.parse(await tools.subagent({prompt:"before consent reset"})); text(await tools.get_subagent_result({...child, wait:true}));',
            }),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("existing child ready"),
          fauxAssistantMessage("child created"),
        ]);
        await deliver("create child before consent reset");
        const childEntries = await rootConversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
        const childTasks = childEntries.items.filter((entry) => entry.kind === "orb.subagent-task");
        expect(childTasks).toHaveLength(1);
        const childId = (childTasks[0]!.data as { childId: Parameters<Harness["conversation"]>[0] })
          .childId;
        const child = (await resolveConversation!(childId, BACKGROUND_CONTEXT))!;
        const state = async () => {
          const record = await storage.findDocument(
            {
              kind: AgentDoc.definition.kind,
              scope: { kind: "conversation", conversationId: childId },
            },
            "current",
            BACKGROUND_CONTEXT,
          );
          return (await storage.document(record!.id, "current", BACKGROUND_CONTEXT))!.value;
        };
        const beforeWhitelist = (await state()).tools;
        expect(beforeWhitelist).toEqual(
          options.registry
            .snapshot()
            .extension(options.childExtension!.name)!
            .tools!.map((tool) => tool.name),
        );
        expect(beforeWhitelist).toContain("mcp__fixture__read");
        expect(await state()).toMatchObject({ modelTools: ["codemode"] });
        expect(JSON.stringify(await state())).not.toContain("mcp__fixture__read_after_reset");

        authorized = false;
        faux.setResponses(turn());
        await deliver("consent reset");
        const beforeRecovery = acceptedCalls;
        recovered = true;
        authorized = true;
        const recoveredCode =
          'text(await describeNamespace("mcp__fixture")); text(await describeTool("mcp__fixture__read_after_reset")); text(await tools.mcp__fixture__read_after_reset({}));';
        faux.setResponses(turn(recoveredCode));
        const restored = await deliver("root recovered after consent reset");
        expect(JSON.stringify(restored.records)).toContain("RESET_CONSENT_INSTRUCTIONS");
        expect(acceptedCalls).toBe(beforeRecovery + 1);
        expect(
          (await rootConversation.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name),
        ).toEqual(["codemode"]);
        expect(
          (await rootConversation.agent(BACKGROUND_CONTEXT)).callable.find(
            (tool) => tool.name === "mcp__fixture__read_after_reset",
          )?.callers,
        ).toEqual(["tools"]);
        expect(JSON.stringify(await state())).not.toContain("mcp__fixture__read_after_reset");

        faux.setResponses(
          turn(`${recoveredCode}
          for (const name of ["subagent", "orb_spawn", "ambient_forbidden"]) {
            let denial = {name, denied:false, reason:"invocation accepted"};
            try { await tools[name](name === "ambient_forbidden" ? {} : {prompt:"forbidden child"}); }
            catch (error) { denial = {name, denied:true, reason:error.message.split(". ")[0]}; }
            text(denial);
          }`),
        );
        const submitted = await child.submit(
          { type: "input", content: "recover in existing child" },
          BACKGROUND_CONTEXT,
        );
        expect((await submitted.wait(BACKGROUND_CONTEXT)).status).toBe("done");
        await child.waitForIdle(BACKGROUND_CONTEXT);
        const childContext = await child.context(BACKGROUND_CONTEXT);
        const childResult = childContext.messages.filter(
          (message) => message.role === "toolResult",
        );
        expect(JSON.stringify(childResult)).toContain("RESET_CONSENT_INSTRUCTIONS");
        expect(JSON.stringify(childResult)).toContain("OAUTH_READ_OK");
        const attemptedDenials = childResult
          .flatMap((message) => message.content)
          .flatMap((part) => (part.type === "text" ? part.text.split("\n") : []))
          .filter((line) => line.startsWith('{"name":'))
          .map((line) => JSON.parse(line))
          .filter((entry) => Object.hasOwn(entry, "denied"));
        expect(attemptedDenials).toEqual(
          forbiddenNames.map((name) => ({
            name,
            denied: true,
            reason: `tools.${name} does not exist`,
          })),
        );
        expect(nativeDenials).toEqual(
          forbiddenNames.map((name) => ({
            name,
            denied: true,
            code: "tool_unavailable",
            reason: `Tool ${name} is not available`,
          })),
        );
        const afterChildEntries = await rootConversation.entries(
          {},
          100,
          undefined,
          BACKGROUND_CONTEXT,
        );
        expect(
          afterChildEntries.items.filter((entry) => entry.kind === "orb.subagent-task"),
        ).toEqual(childTasks);
        expect(
          (await storage.scanConversations({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter(
            (conversation) => conversation.owner,
          ),
        ).toHaveLength(1);
        expect(acceptedCalls).toBe(beforeRecovery + 2);
        expect(forbiddenEffects).toBe(0);
        expect(await state()).toMatchObject({
          modelTools: ["codemode"],
          tools: (beforeWhitelist as string[])
            .filter((name) => name !== "codemode")
            .concat("mcp__fixture__read_after_reset", "codemode"),
        });
        const childAgent = await child.agent(BACKGROUND_CONTEXT);
        expect(childAgent.tools.map((tool) => tool.name)).toEqual(["codemode"]);
        for (const name of ["subagent", "orb_spawn", "ambient_forbidden"])
          expect(childAgent.callable.some((tool) => tool.name === name)).toBe(false);
        expect(
          childAgent.callable.find((tool) => tool.name === "mcp__fixture__read_after_reset")
            ?.callers,
        ).toEqual(["tools"]);
        expect(agent.health()).toMatchObject({
          sessionId: identity.sessionId,
          runtimeInstanceId: identity.runtimeInstanceId,
        });
      }
    } finally {
      disposeProgress();
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
