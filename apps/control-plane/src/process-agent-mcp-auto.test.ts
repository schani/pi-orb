import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { DurableAgent } from "./adapters/durable/agent.ts";
import { durableError } from "./adapters/durable/manager.ts";
import * as durableModels from "./adapters/durable/models.ts";
import { McpTools } from "./adapters/durable/tools/mcp.ts";
import { createProcessAgentContext } from "./process-agent-composition.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "./testkit/fixtures.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["lease", "close", "alert-failure"] as const)(
  "automatically publishes MCP while a later server hangs, without status; revocation by %s",
  async (revoke) => {
    const held = barrier(),
      release = barrier(),
      statusEntered = barrier();
    let heldSignal: AbortSignal | undefined;
    const calls: string[] = [];
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const name = new URL(String(input)).hostname.split(".")[0]!;
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const message = JSON.parse(String(init.body));
      if (message.id === undefined) return new Response(null, { status: 202 });
      calls.push(`${name}:${message.method}`);
      if (name === "bad") return new Response("PRIVATE_PROVIDER_ERROR", { status: 503 });
      if (name === "held") {
        heldSignal = init.signal!;
        held.resolve();
        await release.promise;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name, version: "1" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  { name: "ping", description: "Datadog ping", inputSchema: { type: "object" } },
                ],
              }
            : { content: [{ type: "text", text: "AUTO_PONG" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
        headers: { "content-type": "application/json" },
      });
    });
    const h = makeHarness();
    const orb = makeOrbRow("auto-mcp", "project", "running");
    h.store.seedProject(makeProjectRow("project"));
    h.store.seedOrb(orb);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const modelBoundary = vi
      .spyOn(durableModels, "createDurableModels")
      .mockReturnValue(okAsync(models as never));
    const opening = new AbortController();
    const ownership = new AbortController();
    const originalStatusTool = McpTools.prototype.statusTool;
    const statusBoundary = vi.spyOn(McpTools.prototype, "statusTool").mockImplementation(function (
      this: McpTools,
      discover,
    ) {
      const registration = originalStatusTool.call(this, discover);
      return {
        ...registration,
        execute: async (args, api, ctx) => {
          const result = registration.execute(args, api, ctx);
          statusEntered.resolve();
          return result;
        },
      };
    });
    const alertBoundary =
      revoke === "alert-failure"
        ? vi
            .spyOn(DurableAgent.prototype, "appendAlert")
            .mockReturnValueOnce(errAsync(durableError("alert unavailable")))
        : undefined;
    let agent: DurableAgent | undefined;
    try {
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
        mcp: {
          read: () =>
            okAsync({
              revision: 0,
              servers: ["bad", "datadog", "held"].map((name) => ({
                name,
                url: `https://${name}.test/mcp`,
                headers: {},
              })),
            }),
        },
      } as never);
      const storage = new MemoryStorage();
      const options = (
        await open(
          new NoSimulationTask("automatic MCP", false),
          orb,
          { signal: opening.signal },
          false,
          {
            storage,
            signal: ownership.signal,
            check: () => okAsync(undefined),
            checkInputAdmission: () => okAsync(undefined),
            beginDrain: () => okAsync(undefined),
            release: () => okAsync(undefined),
            artifacts: {
              read: () => okAsync(null),
              write: () => okAsync("/orb-artifacts/fixture"),
            },
          },
        )
      )._unsafeUnwrap();
      expect(options.activateResources).toBeTypeOf("function");
      expect(calls).toEqual([]);
      const { envFor: _envFor, ...nativeOptions } = options;
      agent = (
        await DurableAgent.open({
          ...nativeOptions,
          orbId: orb.id,
          storage,
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
        })
      )._unsafeUnwrap();
      opening.abort();
      await held.promise;
      expect(heldSignal?.aborted).toBe(false);
      const snapshot = JSON.stringify(agent.snapshot()._unsafeUnwrap().records);
      expect(snapshot.includes("MCP bad: unavailable.")).toBe(revoke !== "alert-failure");
      expect(snapshot).not.toContain("PRIVATE_PROVIDER_ERROR");
      const requests: string[] = [];
      faux.setResponses([
        (request) => {
          requests.push(JSON.stringify(request));
          return fauxAssistantMessage(
            fauxToolCall("codemode", {
              code: 'text((await searchTools("Datadog")).some(t => t.name === "mcp__datadog__ping") ? "AUTO_SEARCH_OK" : "missing"); text(await describeNamespace("mcp__held")); text(await tools.bash({command:"printf LOCAL_OK"})); text(await tools.mcp__datadog__ping({}));',
            }),
            { stopReason: "toolUse" },
          );
        },
        fauxAssistantMessage("done"),
      ]);
      (
        await agent.deliver({
          baseUrl: "central",
          messageId: "go",
          messageIds: ["go"],
          content: [{ type: "text", text: "go" }],
        })
      )._unsafeUnwrap();
      (await agent.waitForIdle())._unsafeUnwrap();
      const history = JSON.stringify(agent.snapshot()._unsafeUnwrap().records);
      expect(history).toContain("LOCAL_OK");
      expect(history).toContain("AUTO_PONG");
      expect(history).toContain("AUTO_SEARCH_OK");
      expect(history).toContain("pending");
      expect(history).not.toContain("PRIVATE_PROVIDER_ERROR");
      expect(requests[0]).toContain("MCP bad: unavailable.");
      expect(requests[0]).toContain("MCP held: pending.");
      expect(calls.filter((call) => call === "datadog:tools/list")).toHaveLength(1);
      const entries = await storage.scanEntries(
        { conversationId: ROOT_CONVERSATION_ID },
        200,
        undefined,
        BACKGROUND_CONTEXT,
      );
      expect(entries.items.filter((entry) => entry.kind === "orb.alert")).toHaveLength(
        revoke === "alert-failure" ? 0 : 1,
      );
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("codemode", { code: "text(await tools.mcp_status({}));" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);
      (
        await agent.deliver({
          baseUrl: "central",
          messageId: "status",
          messageIds: ["status"],
          content: [{ type: "text", text: "status" }],
        })
      )._unsafeUnwrap();
      await statusEntered.promise;
      if (revoke === "lease") ownership.abort();
      const closing = agent.close();
      expect(heldSignal?.aborted).toBe(true);
      release.resolve();
      (await closing)._unsafeUnwrap();
      expect(
        agent
          .snapshot()
          ._unsafeUnwrap()
          .records.filter((record) => record.type === "event" && record.eventType === "orb.alert"),
      ).toHaveLength(revoke === "alert-failure" ? 0 : 1);
      expect(calls).not.toContain("held:tools/list");
    } finally {
      release.resolve();
      await agent?.close();
      network.mockRestore();
      modelBoundary.mockRestore();
      statusBoundary.mockRestore();
      alertBoundary?.mockRestore();
    }
  },
);
