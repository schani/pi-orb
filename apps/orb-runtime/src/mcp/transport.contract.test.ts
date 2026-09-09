import { createServer } from "node:http";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { HttpMcpTransport } from "./transport.ts";

it.each([200, 404])(
  "uses real SDK HTTP and handles optional method-not-found over HTTP %s without replaying writes",
  async (unsupportedStatus) => {
    const methods: string[] = [];
    let dropWrite = false;
    let templatesUnsupported = false;
    const server = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      expect(req.headers.authorization).toBe("Bearer synthetic");
      expect(req.headers["dd_api_key"]).toBe("synthetic-api-key");
      expect(req.headers["dd_application_key"]).toBe("synthetic-app-key");
      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      methods.push(message.method);
      if (dropWrite && message.method === "tools/call") {
        res.destroy();
        return;
      }
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const results: Record<string, unknown> = {
        initialize: {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {}, prompts: {}, resources: {} },
          serverInfo: { name: "test", version: "1", description: "Testing" },
        },
        "tools/list": {
          tools: [
            {
              name: "echo",
              description: "Echo",
              inputSchema: {
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          ],
        },
        "prompts/list": { prompts: [{ name: "explain" }] },
        "resources/list": { resources: [{ name: "readme", uri: "test://readme" }] },
        "resources/templates/list": {
          resourceTemplates: [{ name: "item", uriTemplate: "test://{id}" }],
        },
        "tools/call": { content: [{ type: "text", text: "success" }] },
        "prompts/get": {
          messages: [{ role: "user", content: { type: "text", text: "untrusted" } }],
        },
        "resources/read": { contents: [{ uri: "test://readme", text: "readme" }] },
      };
      if (templatesUnsupported) delete results["resources/templates/list"];
      if (message.method === "tools/list") {
        results["tools/list"] =
          message.params?.cursor === "page2"
            ? { tools: [{ name: "second", inputSchema: { type: "object" } }] }
            : { ...(results["tools/list"] as object), nextCursor: "page2" };
      }
      res
        .writeHead(
          templatesUnsupported && message.method === "resources/templates/list"
            ? unsupportedStatus
            : 200,
          { "content-type": "application/json" },
        )
        .end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            ...(message.method in results
              ? { result: results[message.method] }
              : { error: { code: -32601, message: "unknown method" } }),
          }),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const transport = new HttpMcpTransport(`http://127.0.0.1:${address.port}/mcp`, {
      Authorization: "Bearer synthetic",
      DD_API_KEY: "synthetic-api-key",
      DD_APPLICATION_KEY: "synthetic-app-key",
    });
    const task = new NoSimulationTask("http contract", false);
    const connected = await transport.connect(task, AbortSignal.timeout(5000));
    try {
      expect(connected.isOk()).toBe(true);
      const session = connected._unsafeUnwrap();
      const catalog = await session.perform(task, { method: "catalog" }, AbortSignal.timeout(5000));
      expect(catalog._unsafeUnwrap()).toMatchObject([
        { kind: "tool", inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema" } },
        { kind: "tool" },
        { kind: "prompt" },
        { kind: "resource" },
        { kind: "template" },
      ]);
      expect(
        (
          await session.perform(
            task,
            { method: "tools/call", name: "echo", arguments: { value: "first" } },
            AbortSignal.timeout(5000),
          )
        ).isOk(),
      ).toBe(true);
      const invalid = await session.perform(
        task,
        { method: "tools/call", name: "echo", arguments: { value: 42 } },
        AbortSignal.timeout(5000),
      );
      expect(invalid.isErr()).toBe(true);
      expect(methods.filter((method) => method === "tools/call")).toHaveLength(1);
      expect(
        (
          await session.perform(
            task,
            { method: "tools/call", name: "echo", arguments: { value: "x" } },
            AbortSignal.timeout(5000),
          )
        ).isOk(),
      ).toBe(true);
      expect(methods.filter((method) => method === "tools/list")).toHaveLength(2);
      expect(
        (
          await session.perform(
            task,
            { method: "prompts/get", name: "explain", arguments: {} },
            AbortSignal.timeout(5000),
          )
        )._unsafeUnwrap(),
      ).toMatchObject({ messages: [{ role: "user" }] });
      expect(
        (
          await session.perform(
            task,
            { method: "resources/read", uri: "test://readme" },
            AbortSignal.timeout(5000),
          )
        )._unsafeUnwrap(),
      ).toMatchObject({ contents: [{ uri: "test://readme" }] });
      dropWrite = true;
      expect(
        (
          await session.perform(
            task,
            { method: "tools/call", name: "echo", arguments: { value: "x" } },
            AbortSignal.timeout(5000),
          )
        ).isErr(),
      ).toBe(true);
      expect(methods.filter((method) => method === "tools/call")).toHaveLength(3);
      await session.close();
      templatesUnsupported = true;
      const withoutTemplates = (
        await transport.connect(task, AbortSignal.timeout(5000))
      )._unsafeUnwrap();
      const partialSupport = await withoutTemplates.perform(
        task,
        { method: "catalog" },
        AbortSignal.timeout(5000),
      );
      expect(partialSupport._unsafeUnwrap()).toMatchObject([
        { kind: "tool" },
        { kind: "tool" },
        { kind: "prompt" },
        { kind: "resource" },
      ]);
      await withoutTemplates.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
