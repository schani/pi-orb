import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { DurableAgent } from "./agent.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";
import { createDurableModels } from "./models.ts";
import { createDurableTools } from "./tools/index.ts";

type Body = {
  prompt_cache_key?: unknown;
  instructions?: unknown;
  tools?: unknown;
  input?: unknown[];
};

function completed(id: string, items: unknown[]) {
  return [
    { type: "response.created", response: { id } },
    ...items.flatMap((item, index) => [
      { type: "response.output_item.added", output_index: index, item },
      { type: "response.output_item.done", output_index: index, item },
    ]),
    {
      type: "response.completed",
      response: { id, status: "completed", usage: { input_tokens: 10, output_tokens: 2 } },
    },
  ];
}
const text = (id: string, value: string) =>
  completed(id, [{ type: "message", id, content: [{ type: "output_text", text: value }] }]);
const call = (id: string, name: string, args: unknown) =>
  completed(id, [
    { type: "function_call", id, call_id: id, name, arguments: JSON.stringify(args) },
  ]);
const reasoned = (id: string, item: unknown) =>
  completed(id, [
    { type: "reasoning", id: `rs_${id}`, summary: [], encrypted_content: `enc_${id}` },
    item,
  ]);

// Regression: pi-durable 1.0.0 sent no prompt_cache_key (docs/postmortems/2026-10-12-durable-codex-prompt-cache.md).
describe("durable Codex prompt cache key", () => {
  it("is stable per conversation across turns and reopen, and distinct for a subagent", async () => {
    const requests: Array<{ owner: "root" | "child"; body: Body }> = [];
    const server = createServer((request, response) => {
      if (request.method !== "POST") {
        response.writeHead(426);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const raw = (
          request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes
        ).toString();
        const body = JSON.parse(raw) as Body;
        const owner = raw.includes("ROOT_TURN_ONE") ? "root" : "child";
        requests.push({ owner, body });
        const outputs = (JSON.stringify(body.input).match(/function_call_output/g) ?? []).length;
        const agentId = /\\"agent_id\\":\\"([^\\]+)\\"/.exec(raw)?.[1];
        const events =
          owner === "child"
            ? text("child", "child done")
            : raw.includes("ROOT_TURN_THREE")
              ? text("third", "third done")
              : raw.includes("ROOT_TURN_TWO")
                ? text("second", "second done")
                : outputs === 0
                  ? call("spawn", "subagent", { prompt: "CHILD_TASK" })
                  : outputs === 1
                    ? call("wait", "get_subagent_result", { agent_id: agentId, wait: true })
                    : text("first", "first done");
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const claims = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }),
    ).toString("base64url");
    const persistence = new MemoryAgentPersistence();
    const open = async () => {
      const models = (
        await createDurableModels({
          token: () =>
            okAsync({ accessToken: `header.${claims}.signature`, expiresAt: Date.now() + 3600000 }),
          inferenceBaseUrl: `http://127.0.0.1:${address.port}`,
        })
      )._unsafeUnwrap();
      const registry = createRegistry();
      registry.install(createDurableTools().extension);
      const { storage } = (await persistence.openOrb("orb", false))._unsafeUnwrap();
      return (
        await DurableAgent.open({
          orbId: "orb",
          storage,
          models,
          registry,
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: "commit",
          instructions: "instruction",
          initialSettings: {
            model: { provider: "openai-codex", id: "gpt-6-astra" },
            thinkingLevel: "off",
          },
        })
      )._unsafeUnwrap();
    };
    const turn = async (agent: DurableAgent, id: string) => {
      (
        await agent.deliver({
          baseUrl: "unused",
          messageId: id,
          messageIds: [id],
          content: [{ type: "text", text: id }],
        })
      )._unsafeUnwrap();
      (await agent.waitForIdle())._unsafeUnwrap();
    };
    try {
      const first = await open();
      try {
        await turn(first, "ROOT_TURN_ONE");
        await turn(first, "ROOT_TURN_TWO");
      } finally {
        await first.close();
      }
      const reopened = await open();
      try {
        await turn(reopened, "ROOT_TURN_THREE");
      } finally {
        await reopened.close();
      }
      const keys = (owner: "root" | "child") =>
        requests.filter((r) => r.owner === owner).map((r) => r.body.prompt_cache_key);
      const root = keys("root");
      const child = keys("child");
      expect(root).toHaveLength(5);
      expect(child).toHaveLength(1);
      expect(root[0]).toEqual(expect.stringMatching(/\S/));
      expect(new Set(root)).toEqual(new Set([root[0]]));
      expect(child[0]).toEqual(expect.stringMatching(/\S/));
      expect(child[0]).not.toBe(root[0]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Regression: the orb prompt rode at the tail of every request, so no request extended the previous one.
  it("sends the orb prompt as instructions, then one in-place update, extending each previous request", async () => {
    const requests: Body[] = [];
    let prompt = "PENDING_PROMPT";
    let id = 0;
    const server = createServer((request, response) => {
      if (request.method !== "POST") {
        response.writeHead(426);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const raw = (
          request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes
        ).toString();
        const body = JSON.parse(raw) as Body;
        requests.push(body);
        const outputs = (JSON.stringify(body.input).match(/function_call_output/g) ?? []).length;
        const agentId = /\\"agent_id\\":\\"([^\\]+)\\"/.exec(raw)?.[1];
        const next = `r${id++}`;
        const bash = (command: string) =>
          reasoned(next, {
            type: "function_call",
            id: `fc_${next}`,
            call_id: `call_${next}`,
            name: "bash",
            arguments: JSON.stringify({ command }),
          });
        const fn = (name: string, args: unknown) =>
          reasoned(next, {
            type: "function_call",
            id: `fc_${next}`,
            call_id: `call_${next}`,
            name,
            arguments: JSON.stringify(args),
          });
        const done = (value: string) =>
          reasoned(next, {
            type: "message",
            id: `msg_${next}`,
            content: [{ type: "output_text", text: value }],
          });
        const events = !raw.includes("ROOT_TURN")
          ? outputs < 3
            ? bash(`echo child${outputs}`)
            : done("child done")
          : raw.includes("ROOT_TURN_TWO")
            ? outputs < 5
              ? bash(`echo root${outputs}`)
              : done("second done")
            : outputs === 0
              ? fn("subagent", { prompt: "CHILD_TASK" })
              : outputs === 1
                ? fn("get_subagent_result", { agent_id: agentId, wait: true })
                : done("first done");
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const claims = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }),
    ).toString("base64url");
    const { storage } = (await new MemoryAgentPersistence().openOrb("orb", false))._unsafeUnwrap();
    const models = (
      await createDurableModels({
        token: () =>
          okAsync({ accessToken: `header.${claims}.signature`, expiresAt: Date.now() + 3600000 }),
        inferenceBaseUrl: `http://127.0.0.1:${address.port}`,
      })
    )._unsafeUnwrap();
    const registry = createRegistry();
    registry.install(createDurableTools().extension);
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage,
        models,
        registry,
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "pending",
        prompt: () => prompt,
        initialSettings: {
          model: { provider: "openai-codex", id: "gpt-6-astra" },
          thinkingLevel: "medium",
        },
      })
    )._unsafeUnwrap();
    const turn = async (text: string) => {
      (
        await agent.deliver({
          baseUrl: "unused",
          messageId: text,
          messageIds: [text],
          content: [{ type: "text", text }],
        })
      )._unsafeUnwrap();
      (await agent.waitForIdle())._unsafeUnwrap();
    };
    try {
      await turn("ROOT_TURN_ONE");
      prompt = "ORB_PROMPT";
      await turn("ROOT_TURN_TWO");
    } finally {
      await agent.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const conversations = new Map<unknown, Body[]>();
    for (const body of requests)
      conversations.set(body.prompt_cache_key, [
        ...(conversations.get(body.prompt_cache_key) ?? []),
        body,
      ]);
    expect(conversations.size).toBe(2);
    expect([...conversations.values()].map((bodies) => bodies.length).sort()).toEqual([4, 7]);
    for (const bodies of conversations.values()) {
      for (const body of bodies) {
        const input = JSON.stringify(body.input);
        expect(body.instructions).toBe("PENDING_PROMPT");
        expect(input.split("ORB_PROMPT").length - 1).toBe(input.includes("ROOT_TURN_TWO") ? 1 : 0);
      }
      for (const [index, body] of bodies.entries()) {
        const previous = bodies[index - 1];
        if (!previous) continue;
        expect(body.tools).toEqual(previous.tools);
        expect(body.input?.slice(0, previous.input?.length)).toEqual(previous.input);
      }
    }
  });
});
