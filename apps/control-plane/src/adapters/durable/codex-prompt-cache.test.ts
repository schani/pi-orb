import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { okAsync } from "neverthrow";
import { describe, expect, it, onTestFinished } from "vitest";
import { DurableAgent } from "./agent.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";
import { createDurableModels } from "./models.ts";
import { createDurableTools } from "./tools/index.ts";

type Body = {
  prompt_cache_key?: unknown;
  instructions?: unknown;
  tools?: unknown;
  input?: Array<{ type?: string; role?: string; content?: unknown; output?: string }>;
};

const spawnCode =
  'const child = JSON.parse(await tools.subagent({prompt:"CHILD_TASK"})); store("child", child.agent_id); text(child);';
const waitCode =
  'text(JSON.parse(await tools.get_subagent_result({agent_id:load("child"),wait:true})).receipt);';
const toolOutputs = (body: Body) =>
  body.input?.filter((item) => item.type === "custom_tool_call_output") ?? [];

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
const codeCall = (id: string, code: string) => ({
  type: "custom_tool_call",
  id: `ctc_${id}`,
  call_id: `call_${id}`,
  name: "codemode",
  input: code,
});
const call = (id: string, code: string) => completed(id, [codeCall(id, code)]);
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
        const outputs = toolOutputs(body).length;
        const events =
          owner === "child"
            ? text("child", "child done")
            : raw.includes("ROOT_TURN_THREE")
              ? text("third", "third done")
              : raw.includes("ROOT_TURN_TWO")
                ? text("second", "second done")
                : outputs === 0
                  ? call("spawn", spawnCode)
                  : outputs === 1
                    ? call("wait", waitCode)
                    : text("first", "first done");
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
    });
    onTestFinished(async () => {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
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
      const tools = createDurableTools();
      onTestFinished(async () => {
        (await tools.close())._unsafeUnwrap();
      });
      registry.install(tools.extension);
      registry.install(tools.childExtension);
      const { storage } = (await persistence.openOrb("orb", false))._unsafeUnwrap();
      onTestFinished(() => storage.close({} as never));
      return (
        await DurableAgent.open({
          orbId: "orb",
          storage,
          models,
          registry,
          modelTools: tools.modelTools,
          childExtension: tools.childExtension,
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
      for (const { body } of requests)
        expect(body.tools).toEqual([expect.objectContaining({ type: "custom", name: "codemode" })]);
      const lastRoot = requests.filter((request) => request.owner === "root").at(-1)!;
      expect(toolOutputs(lastRoot.body)[1]?.output?.split("\n").at(-1)).toBe(
        JSON.stringify({ status: "completed", result: { output: "child done" } }),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Regression: the orb prompt rode at the tail of every request, so no request extended the previous one.
  it("sends pinned instructions across turns and child calls, extending each previous request", async () => {
    const requests: Body[] = [];
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
        const outputs = toolOutputs(body).length;
        const next = `r${id++}`;
        const fn = (code: string) => reasoned(next, codeCall(next, code));
        const bash = (command: string) =>
          fn(`text(await tools.bash(${JSON.stringify({ command })}));`);
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
              ? fn(spawnCode)
              : outputs === 1
                ? fn(waitCode)
                : done("first done");
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
    });
    onTestFinished(async () => {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const claims = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }),
    ).toString("base64url");
    const { storage } = (await new MemoryAgentPersistence().openOrb("orb", false))._unsafeUnwrap();
    onTestFinished(() => storage.close({} as never));
    const models = (
      await createDurableModels({
        token: () =>
          okAsync({ accessToken: `header.${claims}.signature`, expiresAt: Date.now() + 3600000 }),
        inferenceBaseUrl: `http://127.0.0.1:${address.port}`,
      })
    )._unsafeUnwrap();
    const registry = createRegistry();
    const tools = createDurableTools();
    onTestFinished(async () => {
      (await tools.close())._unsafeUnwrap();
    });
    registry.install(tools.extension);
    registry.install(tools.childExtension);
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage,
        models,
        registry,
        modelTools: tools.modelTools,
        childExtension: tools.childExtension,
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "PINNED_PROMPT",
        initialSettings: {
          model: { provider: "openai-codex", id: "gpt-6-astra" },
          thinkingLevel: "medium",
        },
      })
    )._unsafeUnwrap();
    onTestFinished(async () => {
      (await agent.close())._unsafeUnwrap();
    });
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
    await turn("ROOT_TURN_ONE");
    await turn("ROOT_TURN_TWO");
    await agent.close();
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
        const childNote = input.includes("ROOT_TURN")
          ? ""
          : `\n\n- You are a subagent. Your parent started you in this same orb; you share its filesystem.
- To communicate with your parent agent you have \`notify_parent\`. Do not use \`orb_send\` for that!!!
- Do not start subagents or orbs!`;
        expect(body.instructions).toBe(bodies[0]?.instructions);
        const instructions = String(body.instructions);
        const sections = [...instructions.matchAll(/<([a-z-]+)>\n([\s\S]*?)\n<\/\1>/g)];
        expect(sections.map((match) => match[1]).sort()).toEqual([
          "orb-instructions",
          "tool-catalogue",
        ]);
        expect(sections.map((match) => match[0]).join("\n\n")).toBe(instructions);
        expect(sections.find((match) => match[1] === "orb-instructions")?.[2]).toBe(
          `PINNED_PROMPT${childNote}`,
        );
        expect(sections.find((match) => match[1] === "tool-catalogue")?.[2]).toEqual(
          expect.stringMatching(/\S/),
        );
        expect(body.tools).toEqual([expect.objectContaining({ type: "custom", name: "codemode" })]);
        expect(input).not.toContain("PINNED_PROMPT");
        expect(body.input?.filter((item) => item.role === "developer")).toEqual([]);
        if (input.includes("ROOT_TURN") && toolOutputs(body).length >= 2)
          expect(toolOutputs(body)[1]?.output?.split("\n").at(-1)).toBe(
            JSON.stringify({ status: "completed", result: { output: "child done" } }),
          );
      }
      for (const [index, body] of bodies.entries()) {
        const previous = bodies[index - 1];
        if (!previous) continue;
        expect(body.tools).toEqual(previous.tools);
        expect(body.input!.length).toBeGreaterThan(previous.input!.length);
        expect(body.input?.slice(0, previous.input?.length)).toEqual(previous.input);
      }
    }
  });
});
